// Package grpcweb implémente un client gRPC-web minimal (appels unaires) qui
// satisfait grpc.ClientConnInterface.
//
// ChirpStack v4 expose son API en gRPC-web sur le même port et la même URL que
// son interface web : en parlant gRPC-web, l'outil fonctionne partout où
// l'interface ChirpStack fonctionne, y compris derrière un reverse proxy
// HTTP/1.1 (nginx, traefik...) ou sous un sous-chemin.
package grpcweb

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// maxMessageSize borne la taille d'une réponse (listes de devices volumineuses).
const maxMessageSize = 64 << 20

// Conn envoie les appels gRPC en gRPC-web vers baseURL.
type Conn struct {
	baseURL string
	client  *http.Client
}

var _ grpc.ClientConnInterface = (*Conn)(nil)

// New crée une connexion vers baseURL (ex. "https://chirpstack.example.com").
func New(baseURL string, client *http.Client) *Conn {
	return &Conn{baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

// Invoke réalise un appel unaire.
func (c *Conn) Invoke(ctx context.Context, method string, args, reply any, _ ...grpc.CallOption) error {
	in, ok := args.(proto.Message)
	if !ok {
		return status.Errorf(codes.Internal, "type de requête inattendu %T", args)
	}
	out, ok := reply.(proto.Message)
	if !ok {
		return status.Errorf(codes.Internal, "type de réponse inattendu %T", reply)
	}

	payload, err := proto.Marshal(in)
	if err != nil {
		return status.Errorf(codes.Internal, "encodage de la requête : %v", err)
	}
	frame := make([]byte, 5+len(payload))
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(payload)))
	copy(frame[5:], payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+method, bytes.NewReader(frame))
	if err != nil {
		return status.Errorf(codes.InvalidArgument, "URL ChirpStack invalide : %v", err)
	}
	req.Header.Set("Content-Type", "application/grpc-web+proto")
	req.Header.Set("Accept", "application/grpc-web+proto")
	req.Header.Set("X-Grpc-Web", "1")
	if md, ok := metadata.FromOutgoingContext(ctx); ok {
		for k, vs := range md {
			if strings.HasPrefix(k, "grpcgateway-") || k == "x-forwarded-for" || k == "x-forwarded-host" {
				continue
			}
			for _, v := range vs {
				if strings.HasSuffix(k, "-bin") {
					v = base64.StdEncoding.EncodeToString([]byte(v))
				}
				req.Header.Add(k, v)
			}
		}
	}

	resp, err := c.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return status.FromContextError(ctx.Err()).Err()
		}
		return status.Errorf(codes.Unavailable, "impossible de joindre ChirpStack (%s) : %v", c.baseURL, unwrapURLError(err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return httpStatusError(resp)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/grpc-web") {
		return status.Errorf(codes.Unimplemented,
			"le serveur %s ne répond pas comme une API ChirpStack (Content-Type %q) : vérifiez l'URL", c.baseURL, ct)
	}

	// Réponse « trailers-only » : le statut est directement dans les en-têtes.
	if s := resp.Header.Get("Grpc-Status"); s != "" {
		if err := statusFrom(s, resp.Header.Get("Grpc-Message")); err != nil {
			return err
		}
	}

	var gotMessage bool
	body := io.LimitReader(resp.Body, maxMessageSize+5)
	for {
		var hdr [5]byte
		if _, err := io.ReadFull(body, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return status.Errorf(codes.Internal, "réponse gRPC-web tronquée : %v", err)
		}
		n := binary.BigEndian.Uint32(hdr[1:5])
		if n > maxMessageSize {
			return status.Errorf(codes.ResourceExhausted, "réponse trop volumineuse (%d octets)", n)
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(body, data); err != nil {
			return status.Errorf(codes.Internal, "réponse gRPC-web tronquée : %v", err)
		}

		if hdr[0]&0x80 != 0 { // trame de trailers
			tr := parseTrailers(data)
			if err := statusFrom(tr.Get("Grpc-Status"), tr.Get("Grpc-Message")); err != nil {
				return err
			}
			continue
		}
		if hdr[0]&0x01 != 0 {
			return status.Error(codes.Internal, "réponse compressée non supportée")
		}
		if err := proto.Unmarshal(data, out); err != nil {
			return status.Errorf(codes.Internal, "décodage de la réponse : %v", err)
		}
		gotMessage = true
	}

	if !gotMessage {
		return status.Error(codes.Internal, "réponse vide du serveur ChirpStack")
	}
	return nil
}

// NewStream n'est pas supporté : les services relayés n'utilisent que des appels unaires.
func (c *Conn) NewStream(context.Context, *grpc.StreamDesc, string, ...grpc.CallOption) (grpc.ClientStream, error) {
	return nil, status.Error(codes.Unimplemented, "streaming non supporté")
}

func statusFrom(code, msg string) error {
	if code == "" || code == "0" {
		return nil
	}
	c, err := strconv.Atoi(code)
	if err != nil {
		return status.Errorf(codes.Internal, "grpc-status invalide %q", code)
	}
	if m, err := url.PathUnescape(msg); err == nil {
		msg = m
	}
	return status.Error(codes.Code(c), msg)
}

func parseTrailers(data []byte) http.Header {
	h := http.Header{}
	for _, line := range strings.Split(string(data), "\r\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		h.Add(textproto.CanonicalMIMEHeaderKey(strings.TrimSpace(k)), strings.TrimSpace(v))
	}
	return h
}

func httpStatusError(resp *http.Response) error {
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
	detail := strings.TrimSpace(string(snippet))
	if detail != "" {
		detail = " : " + detail
	}
	var c codes.Code
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		c = codes.Unauthenticated
	case http.StatusForbidden:
		c = codes.PermissionDenied
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusUnsupportedMediaType:
		c = codes.Unimplemented
	case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		c = codes.Unavailable
	default:
		c = codes.Unknown
	}
	return status.Error(c, fmt.Sprintf("HTTP %d depuis %s%s", resp.StatusCode, resp.Request.URL.Host, detail))
}

func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
