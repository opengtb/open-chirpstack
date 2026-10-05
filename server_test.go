package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"google.golang.org/protobuf/proto"

	csapi "open-chirpstack/internal/csapi"
)

const testPort = 8765

// fakeChirpStack imite l'API gRPC-web de ChirpStack pour TenantService/List.
func fakeChirpStack(t *testing.T, onRequest func(r *http.Request, req *csapi.ListTenantsRequest) (int, string)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api.TenantService/List" {
			http.NotFound(w, r)
			return
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/grpc-web+proto" {
			t.Errorf("Content-Type = %q", ct)
		}
		body, _ := io.ReadAll(r.Body)
		if len(body) < 5 || int(binary.BigEndian.Uint32(body[1:5])) != len(body)-5 {
			t.Fatalf("trame gRPC-web invalide: %x", body)
		}
		var req csapi.ListTenantsRequest
		if err := proto.Unmarshal(body[5:], &req); err != nil {
			t.Fatal(err)
		}

		code, msg := onRequest(r, &req)
		w.Header().Set("Content-Type", "application/grpc-web+proto")
		if code != 0 {
			w.Header().Set("Grpc-Status", strconv.Itoa(code))
			w.Header().Set("Grpc-Message", msg)
			return
		}
		resp, _ := proto.Marshal(&csapi.ListTenantsResponse{
			TotalCount: 1,
			Result:     []*csapi.TenantListItem{{Id: "t-1", Name: "Démo"}},
		})
		writeFrame(w, 0x00, resp)
		writeFrame(w, 0x80, []byte("grpc-status:0\r\ngrpc-message:\r\n"))
	}))
}

func writeFrame(w io.Writer, flag byte, data []byte) {
	hdr := make([]byte, 5)
	hdr[0] = flag
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(data)))
	w.Write(hdr)
	w.Write(data)
}

func newTestServer() http.Handler {
	return newServer(fstest.MapFS{"index.html": {Data: []byte("<html>ok</html>")}}, testPort)
}

func do(h http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://127.0.0.1:"+strconv.Itoa(testPort)+path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestListTenantsThroughGrpcWeb(t *testing.T) {
	cs := fakeChirpStack(t, func(r *http.Request, req *csapi.ListTenantsRequest) (int, string) {
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("Authorization = %q", got)
		}
		if req.Limit != 100 || req.Offset != 10 {
			t.Errorf("limit/offset = %d/%d", req.Limit, req.Offset)
		}
		return 0, ""
	})
	defer cs.Close()

	rec := do(newTestServer(), "GET", "/api/tenants?limit=100&offset=10", map[string]string{
		"Grpc-Metadata-Authorization": "Bearer secret",
		headerServer:                  cs.URL + "/",
	})
	if rec.Code != 200 {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body)
	}
	var out struct {
		TotalCount int `json:"totalCount"`
		Result     []struct{ ID, Name string }
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.TotalCount != 1 || len(out.Result) != 1 || out.Result[0].Name != "Démo" {
		t.Fatalf("réponse inattendue: %s", rec.Body)
	}
}

func TestGrpcErrorIsMappedToHTTP(t *testing.T) {
	cs := fakeChirpStack(t, func(*http.Request, *csapi.ListTenantsRequest) (int, string) {
		return 16, "invalid%20token" // UNAUTHENTICATED
	})
	defer cs.Close()

	rec := do(newTestServer(), "GET", "/api/tenants", map[string]string{headerServer: cs.URL})
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid token") {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestWrongURLGivesClearError(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html></html>"))
	}))
	defer other.Close()

	rec := do(newTestServer(), "GET", "/api/tenants", map[string]string{headerServer: other.URL})
	if rec.Code == 200 || !strings.Contains(rec.Body.String(), "vérifiez l'URL") {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestRestMode(t *testing.T) {
	rest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tenants" || r.Header.Get("Origin") != "" {
			t.Errorf("requête relayée inattendue: %s origin=%q", r.URL, r.Header.Get("Origin"))
		}
		w.Write([]byte(`{"totalCount":"0","result":[]}`))
	}))
	defer rest.Close()

	rec := do(newTestServer(), "GET", "/api/tenants", map[string]string{
		headerServer: rest.URL, headerMode: "rest", "Origin": "http://127.0.0.1:8765",
	})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "totalCount") {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestSecurityChecks(t *testing.T) {
	h := newTestServer()

	req := httptest.NewRequest("GET", "http://evil.example:8765/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("hôte étranger accepté: %d", rec.Code)
	}

	rec = do(h, "GET", "/api/tenants", map[string]string{headerServer: "http://x", "Origin": "https://evil.example"})
	if rec.Code != http.StatusForbidden {
		t.Errorf("origine étrangère acceptée: %d", rec.Code)
	}

	rec = do(h, "OPTIONS", "/api/tenants", nil)
	if rec.Code != http.StatusForbidden {
		t.Errorf("pré-requête CORS acceptée: %d", rec.Code)
	}

	rec = do(h, "GET", "/api/tenants", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("requête sans serveur cible: %d", rec.Code)
	}

	rec = do(h, "GET", "/", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "ok") {
		t.Errorf("page d'accueil: %d %s", rec.Code, rec.Body)
	}
}

func TestRedirectGivesClearError(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://chirpstack.example.com"+r.URL.Path, http.StatusMovedPermanently)
	}))
	defer target.Close()

	rec := do(newTestServer(), "GET", "/api/tenants?limit=10", map[string]string{headerServer: target.URL})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, corps = %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "https://chirpstack.example.com") {
		t.Fatalf("message sans l'adresse de redirection : %s", rec.Body)
	}
}

func TestStaticHeaders(t *testing.T) {
	srv := newServer(fstest.MapFS{"index.html": {Data: []byte("ok")}, "js/app.js": {Data: []byte("1")}}, testPort)
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/js/app.js", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") {
		t.Fatalf("CSP absente : %q", csp)
	}

	req = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765"+pingPath, nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get(pingHeader) != "1" {
		t.Fatalf("ping : code %d", rec.Code)
	}
}

func TestNormalizeURL(t *testing.T) {
	for in, want := range map[string]string{
		"192.168.1.10:8080":             "http://192.168.1.10:8080",
		"https://cs.example.com/":       "https://cs.example.com",
		" https://x.fr/chirpstack/#/ ":  "https://x.fr/chirpstack",
		"http://user:pw@host:8080/?a=b": "http://host:8080",
	} {
		u, err := normalizeURL(in)
		if err != nil || u.String() != want {
			t.Errorf("normalizeURL(%q) = %v, %v ; attendu %q", in, u, err, want)
		}
	}
	for _, in := range []string{"", "ftp://x", "http://"} {
		if _, err := normalizeURL(in); err == nil {
			t.Errorf("normalizeURL(%q) devrait échouer", in)
		}
	}
}
