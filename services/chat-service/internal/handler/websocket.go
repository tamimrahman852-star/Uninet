// Package handler contains the HTTP/WebSocket entrypoints and frame handlers of the chat service.
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"github.com/uninet/chat-service/internal"
	"github.com/uninet/chat-service/internal/protocol"
	"github.com/uninet/chat-service/internal/storage"
)

type tokenClaims struct {
	jwt.RegisteredClaims
}

// WebSocketServer authenticates and upgrades connections, and exposes health endpoints.
type WebSocketServer struct {
	cfg      *internal.Config
	hub      *internal.Hub
	rdb      *redis.Client
	store    *storage.Store
	log      *slog.Logger
	upgrader websocket.Upgrader
	parser   *jwt.Parser
}

// NewWebSocketServer wires the server. store may be nil.
func NewWebSocketServer(cfg *internal.Config, hub *internal.Hub, rdb *redis.Client, store *storage.Store, log *slog.Logger) *WebSocketServer {
	s := &WebSocketServer{
		cfg:   cfg,
		hub:   hub,
		rdb:   rdb,
		store: store,
		log:   log,
		parser: jwt.NewParser(
			jwt.WithValidMethods([]string{"HS256"}),
			jwt.WithAudience("authenticated"),
			jwt.WithExpirationRequired(),
			jwt.WithLeeway(5*time.Second),
		),
	}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     s.checkOrigin,
	}
	return s
}

// Routes registers all HTTP routes on the mux.
func (s *WebSocketServer) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/chat/ws", s.HandleWS)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", s.handleReady)
}

func (s *WebSocketServer) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.rdb.Ping(ctx).Err(); err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "unavailable", "redis unreachable")
		return
	}
	if s.store != nil {
		if err := s.store.Ping(ctx); err != nil {
			writeJSONError(w, http.StatusServiceUnavailable, "unavailable", "cassandra unreachable")
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (s *WebSocketServer) checkOrigin(r *http.Request) bool {
	origin := strings.ToLower(r.Header.Get("Origin"))
	if origin == "" || s.cfg.AllowAllOrigins {
		return true // non-browser clients (mobile apps) send no Origin
	}
	_, ok := s.cfg.AllowedOrigins[origin]
	return ok
}

func (s *WebSocketServer) authenticate(r *http.Request) (string, time.Time, error) {
	raw := ""
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		raw = strings.TrimSpace(h[7:])
	}
	if raw == "" {
		raw = r.URL.Query().Get("access_token")
	}
	if raw == "" {
		return "", time.Time{}, errors.New("missing access token")
	}
	claims := &tokenClaims{}
	token, err := s.parser.ParseWithClaims(raw, claims, func(*jwt.Token) (interface{}, error) {
		return s.cfg.JWTSecret, nil
	})
	if err != nil || !token.Valid {
		return "", time.Time{}, errors.New("invalid access token")
	}
	userID, ok := protocol.NormalizeUserID(claims.Subject)
	if !ok || claims.ExpiresAt == nil {
		return "", time.Time{}, errors.New("invalid access token")
	}
	return userID, claims.ExpiresAt.Time, nil
}

func sanitizeDeviceID(raw string) string {
	if protocol.ValidID(raw) {
		return raw
	}
	return uuid.NewString()
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// HandleWS authenticates, upgrades and runs a client until it disconnects.
//
//	GET /api/v1/chat/ws?device_id=<id>&proto=json|binary   (Authorization: Bearer <jwt> or ?access_token=<jwt>)
func (s *WebSocketServer) HandleWS(w http.ResponseWriter, r *http.Request) {
	userID, expiresAt, err := s.authenticate(r)
	if err != nil {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		writeJSONError(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return
	}
	if s.hub.ConnectionCount(userID) >= internal.MaxDevicesPerUser {
		writeJSONError(w, http.StatusTooManyRequests, "too_many_connections", "device connection limit reached")
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.log.Warn("websocket upgrade failed", "err", err)
		return // Upgrade has already written the HTTP error response
	}

	binary := r.URL.Query().Get("proto") == "binary"
	client := internal.NewClient(s.hub, conn, userID, sanitizeDeviceID(r.URL.Query().Get("device_id")), expiresAt, binary)
	if err := s.hub.Register(client); err != nil {
		s.log.Error("client registration failed", "user_id", userID, "err", err)
		client.Shutdown(websocket.CloseTryAgainLater, "backplane unavailable")
		return
	}
	client.Log.Info("client connected", "binary", binary)
	client.Run()
	client.Log.Info("client disconnected")
}
