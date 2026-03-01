package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"

	"github.com/anthropics/yepanywhere/emulator-bridge/internal/emulator"
	"github.com/anthropics/yepanywhere/emulator-bridge/internal/encoder"
	"github.com/anthropics/yepanywhere/emulator-bridge/internal/stream"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	emuAddr := flag.String("emu", "localhost:8554", "Emulator gRPC address")
	maxWidth := flag.Int("width", 540, "Max output width for video encoding")
	fps := flag.Int("fps", 30, "Target frame rate for encoder rate control")
	flag.Parse()

	// 1. Connect to emulator.
	log.Printf("Connecting to emulator at %s...", *emuAddr)
	client, err := emulator.NewClient(*emuAddr)
	if err != nil {
		log.Fatalf("Failed to connect to emulator: %v", err)
	}
	defer client.Close()

	srcW, srcH := client.ScreenSize()
	log.Printf("Emulator screen: %dx%d", srcW, srcH)

	// 2. Compute target resolution.
	targetW, targetH := encoder.ComputeTargetSize(int(srcW), int(srcH), *maxWidth)
	log.Printf("Encoding resolution: %dx%d", targetW, targetH)

	// 3. Create h264 encoder.
	h264Enc, err := encoder.NewH264Encoder(targetW, targetH, *fps)
	if err != nil {
		log.Fatalf("Failed to create encoder: %v", err)
	}
	defer h264Enc.Close()

	// 4. Start frame source.
	frameSource := emulator.NewFrameSource(client)
	defer frameSource.Stop()

	// 5. Create input handler.
	inputHandler := stream.NewInputHandler(client)

	// 6. Create signaling handler.
	stunServers := []string{"stun:stun.l.google.com:19302"}
	sigHandler := stream.NewSignalingHandler(
		frameSource, h264Enc, inputHandler,
		stunServers, targetW, targetH,
	)

	// 7. Set up HTTP routes.
	mux := http.NewServeMux()

	// Serve embedded web files.
	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		// Fallback: try the full path (embed includes the ../../web path components differently).
		webRoot, _ = fs.Sub(webFS, ".")
	}
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	mux.HandleFunc("/api/connect", sigHandler.HandleConnect)
	mux.HandleFunc("/api/answer", sigHandler.HandleAnswer)
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"screen":{"width":%d,"height":%d},"encoding":{"width":%d,"height":%d}}`,
			srcW, srcH, targetW, targetH)
	})

	log.Printf("Listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}
