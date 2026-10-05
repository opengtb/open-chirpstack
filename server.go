package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"

	csapi "chirpstack-toolbox/internal/csapi"
	"chirpstack-toolbox/internal/grpcweb"
)

// En-têtes envoyés par l'interface web pour désigner le serveur ChirpStack cible.
const (
	headerServer   = "X-Chirpstack-Server"   // URL du serveur ChirpStack
	headerMode     = "X-Chirpstack-Mode"     // "grpcweb" (défaut) ou "rest"
	headerInsecure = "X-Chirpstack-Insecure" // "1" : ne pas vérifier le certificat TLS
)

const maxCachedTargets = 16

type server struct {
	static http.Handler
	port   string

	mu      sync.Mutex
	targets map[string]http.Handler
}

func newServer(web fs.FS, port int) http.Handler {
	return &server{
		static:  http.FileServer(http.FS(web)),
		port:    strconv.Itoa(port),
		targets: map[string]http.Handler{},
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Protection contre le DNS rebinding : seul l'hôte local est accepté.
	if !s.isLocalHost(r.Host) {
		http.Error(w, "hôte non autorisé", http.StatusForbidden)
		return
	}

	if !strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		s.static.ServeHTTP(w, r)
		return
	}

	// Pas de CORS : seule la page servie par l'outil peut appeler le relais.
	// Une autre origine ne peut pas envoyer l'en-tête X-Chirpstack-Server
	// sans pré-requête OPTIONS, que l'on refuse.
	if origin := r.Header.Get("Origin"); origin != "" && !s.isLocalOrigin(origin) {
		jsonError(w, http.StatusForbidden, "origine non autorisée")
		return
	}
	if r.Method == http.MethodOptions {
		jsonError(w, http.StatusForbidden, "CORS non supporté")
		return
	}

	h, err := s.target(r.Header.Get(headerServer), r.Header.Get(headerMode), r.Header.Get(headerInsecure) == "1")
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	r.Header.Del(headerServer)
	r.Header.Del(headerMode)
	r.Header.Del(headerInsecure)
	h.ServeHTTP(w, r)
}

func (s *server) isLocalHost(hostport string) bool {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return false
	}
	return port == s.port && (host == "127.0.0.1" || host == "localhost" || host == "::1")
}

func (s *server) isLocalOrigin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && u.Scheme == "http" && s.isLocalHost(u.Host)
}

// target renvoie (et met en cache) le handler correspondant au serveur ChirpStack demandé.
func (s *server) target(rawURL, mode string, insecure bool) (http.Handler, error) {
	base, err := normalizeURL(rawURL)
	if err != nil {
		return nil, err
	}
	if mode != "rest" {
		mode = "grpcweb"
	}
	key := mode + "|" + strconv.FormatBool(insecure) + "|" + base.String()

	s.mu.Lock()
	defer s.mu.Unlock()
	if h, ok := s.targets[key]; ok {
		return h, nil
	}
	if len(s.targets) >= maxCachedTargets {
		s.targets = map[string]http.Handler{}
	}

	client := &http.Client{Timeout: 120 * time.Second, Transport: newTransport(insecure)}
	var h http.Handler
	if mode == "rest" {
		h = restProxy(base, client.Transport)
	} else {
		h, err = grpcWebGateway(base.String(), client)
		if err != nil {
			return nil, err
		}
	}
	s.targets[key] = h
	return h, nil
}

func normalizeURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errString("URL du serveur ChirpStack manquante")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errString("URL du serveur ChirpStack invalide : " + raw)
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u, nil
}

func newTransport(insecure bool) *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConnsPerHost = 16
	if insecure {
		t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // choix explicite de l'utilisateur (certificat auto-signé)
	}
	return t
}

// grpcWebGateway traduit l'API REST (/api/...) en appels gRPC-web vers ChirpStack,
// avec les mêmes routes que chirpstack-rest-api.
func grpcWebGateway(base string, client *http.Client) (http.Handler, error) {
	conn := grpcweb.New(base, client)
	mux := runtime.NewServeMux()
	ctx := context.Background()

	for _, register := range []func() error{
		func() error {
			return csapi.RegisterTenantServiceHandlerClient(ctx, mux, csapi.NewTenantServiceClient(conn))
		},
		func() error {
			return csapi.RegisterApplicationServiceHandlerClient(ctx, mux, csapi.NewApplicationServiceClient(conn))
		},
		func() error {
			return csapi.RegisterDeviceServiceHandlerClient(ctx, mux, csapi.NewDeviceServiceClient(conn))
		},
		func() error {
			return csapi.RegisterDeviceProfileServiceHandlerClient(ctx, mux, csapi.NewDeviceProfileServiceClient(conn))
		},
		func() error {
			return csapi.RegisterDeviceProfileTemplateServiceHandlerClient(ctx, mux, csapi.NewDeviceProfileTemplateServiceClient(conn))
		},
		func() error {
			return csapi.RegisterGatewayServiceHandlerClient(ctx, mux, csapi.NewGatewayServiceClient(conn))
		},
		func() error {
			return csapi.RegisterMulticastGroupServiceHandlerClient(ctx, mux, csapi.NewMulticastGroupServiceClient(conn))
		},
		func() error {
			return csapi.RegisterRelayServiceHandlerClient(ctx, mux, csapi.NewRelayServiceClient(conn))
		},
		func() error {
			return csapi.RegisterUserServiceHandlerClient(ctx, mux, csapi.NewUserServiceClient(conn))
		},
	} {
		if err := register(); err != nil {
			return nil, err
		}
	}
	return mux, nil
}

// restProxy relaie tel quel vers un chirpstack-rest-api existant (port 8090 en général).
func restProxy(base *url.URL, transport http.RoundTripper) http.Handler {
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(base)
			pr.Out.Host = base.Host
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Referer")
			pr.Out.Header.Del("Cookie")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			jsonError(w, http.StatusBadGateway, "impossible de joindre l'API REST ChirpStack ("+base.Host+") : "+err.Error())
		},
	}
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "message": msg})
}

type errString string

func (e errString) Error() string { return string(e) }
