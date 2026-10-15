// Uninet chat-service: end-to-end-encrypted message relay over WebSockets.
//
// The server only ever sees opaque ciphertext plus routing metadata and stores clients' PUBLIC key
// bundles (identity key, signed prekey + signature, one-time prekeys) so peers can start sessions
// while the recipient is offline. Messages are persisted (as ciphertext) in Cassandra when configured.
//
// Environment:
//
//	PORT (4002), REDIS_URL (required), SUPABASE_JWT_SECRET (required)
//	ALLOWED_ORIGINS (comma list, "*" allowed; requests without Origin, e.g. mobile apps, always pass)
//	MAX_FRAME_BYTES (131072), OFFLINE_TTL_HOURS (720), OFFLINE_QUEUE_MAX (1000)
//	CASSANDRA_HOSTS (comma list; empty disables history), CASSANDRA_KEYSPACE (uninet_chat),
//	CASSANDRA_USERNAME, CASSANDRA_PASSWORD, CASSANDRA_REPLICATION_FACTOR (1)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"github.com/uninet/chat-service/internal"
	"github.com/uninet/chat-service/internal/handler"
	"github.com/uninet/chat-service/internal/storage"
)

func getenv(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func getInt64(key string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || v <= 0 {
		return fallback
	}
	return v
}

func loadConfig() (*internal.Config, error) {
	secret := strings.TrimSpace(os.Getenv("SUPABASE_JWT_SECRET"))
	if secret == "" {
		return nil, errors.New("SUPABASE_JWT_SECRET is required")
	}
	redisURL := strings.TrimSpace(os.Getenv("REDIS_URL"))
	if redisURL == "" {
		return nil, errors.New("REDIS_URL is required")
	}
	cfg := &internal.Config{
		Port:            getenv("PORT", "4002"),
		RedisURL:        redisURL,
		JWTSecret:       []byte(secret),
		AllowedOrigins:  map[string]struct{}{},
		MaxFrameBytes:   getInt64("MAX_FRAME_BYTES", 128*1024),
		OfflineTTL:      time.Duration(getInt64("OFFLINE_TTL_HOURS", 720)) * time.Hour,
		OfflineQueueMax: getInt64("OFFLINE_QUEUE_MAX", 1000),
	}
	for _, origin := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		origin = strings.ToLower(strings.TrimSpace(origin))
		switch origin {
		case "":
		case "*":
			cfg.AllowAllOrigins = true
		default:
			cfg.AllowedOrigins[origin] = struct{}{}
		}
	}
	return cfg, nil
}

func loadCassandraConfig() (storage.Config, bool) {
	var hosts []string
	for _, h := range strings.Split(os.Getenv("CASSANDRA_HOSTS"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return storage.Config{}, false
	}
	return storage.Config{
		Hosts:             hosts,
		Keyspace:          getenv("CASSANDRA_KEYSPACE", "uninet_chat"),
		Username:          os.Getenv("CASSANDRA_USERNAME"),
		Password:          os.Getenv("CASSANDRA_PASSWORD"),
		ReplicationFactor: int(getInt64("CASSANDRA_REPLICATION_FACTOR", 1)),
	}, true
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := loadConfig()
	if err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Error("invalid REDIS_URL", "err", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		pingCancel()
		log.Error("cannot reach redis", "err", err)
		os.Exit(1)
	}
	pingCancel()

	var store *storage.Store
	if cassCfg, enabled := loadCassandraConfig(); enabled {
		store, err = storage.Open(ctx, cassCfg, log)
		if err != nil {
			log.Error("cannot open cassandra", "err", err)
			os.Exit(1)
		}
		defer store.Close()
		log.Info("cassandra history enabled", "keyspace", cassCfg.Keyspace)
	} else {
		log.Warn("CASSANDRA_HOSTS not set: message history is disabled")
	}

	hub := internal.NewHub(ctx, cfg, rdb, log)
	hub.SetHandler(handler.NewMessaging(hub, store, log))
	server := handler.NewWebSocketServer(cfg, hub, rdb, store, log)

	mux := http.NewServeMux()
	server.Routes(mux)

	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("chat-service listening", "addr", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		log.Error("http server failed", "err", err)
		os.Exit(1)
	case <-ctx.Done():
		log.Info("shutdown signal received")
	}

	// Hijacked WebSocket connections are not covered by http.Server.Shutdown, so close them explicitly.
	hub.CloseAll(websocket.CloseGoingAway, "server restarting")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}
	log.Info("chat-service stopped")
}
