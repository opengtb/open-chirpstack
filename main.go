// ChirpStack Toolbox : un seul exécutable qui sert l'interface web en local
// et relaie les appels vers l'API gRPC de ChirpStack v4.
package main

import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"time"
)

//go:embed web
var webFS embed.FS

var version = "dev"

const defaultPort = 8765

func main() {
	port := flag.Int("port", defaultPort, "port d'écoute local (0 = port libre automatique)")
	noBrowser := flag.Bool("no-browser", false, "ne pas ouvrir le navigateur au démarrage")
	showVersion := flag.Bool("version", false, "afficher la version")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	ln, err := listen(*port)
	if err != nil {
		fail(err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	url := "http://127.0.0.1:" + strconv.Itoa(addr.Port) + "/"

	web, err := fs.Sub(webFS, "web")
	if err != nil {
		fail(err)
	}

	srv := &http.Server{
		Handler:           newServer(web, addr.Port),
		ReadHeaderTimeout: 10 * time.Second,
	}

	fmt.Println()
	fmt.Println("  ==================================================")
	fmt.Println("   ChirpStack Toolbox " + version)
	fmt.Println("  ==================================================")
	fmt.Println("   Interface : " + url)
	fmt.Println()
	fmt.Println("   Gardez cette fenêtre ouverte pendant l'utilisation.")
	fmt.Println("   Fermez-la (ou Ctrl+C) pour arrêter l'outil.")
	fmt.Println("  ==================================================")
	fmt.Println()

	if !*noBrowser {
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				fmt.Println("   Ouvrez manuellement : " + url)
			}
		}()
	}

	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fail(err)
	}
}

// listen écoute uniquement sur la boucle locale. Si le port par défaut est
// déjà pris (outil déjà lancé, autre service), on bascule sur un port libre.
func listen(port int) (net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err == nil || port == 0 {
		return ln, err
	}
	log.Printf("port %d indisponible (%v), utilisation d'un port libre", port, err)
	return net.Listen("tcp", "127.0.0.1:0")
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "Erreur :", err)
	if runtime.GOOS == "windows" {
		// Laisse le temps de lire le message quand l'outil est lancé par double-clic.
		fmt.Fprintln(os.Stderr, "Appuyez sur Entrée pour fermer.")
		fmt.Scanln()
	}
	os.Exit(1)
}
