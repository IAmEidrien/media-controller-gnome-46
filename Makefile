UUID    = media-controller-gnome-46@eidrien.local
SRC     = .
GLIB_COMPILE_SCHEMAS ?= glib-compile-schemas
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP     = $(UUID).shell-extension.zip

# Throwaway virtualenv for the shexli static analyzer. Kept out of the repo and
# reused across runs, since building it hits the network.
SHEXLI_VENV = .shexli-venv
SOURCES = $(wildcard *.js) metadata.json stylesheet.css LICENSE
SCHEMAS = $(wildcard schemas/*.gschema.xml)

.PHONY: all schemas install uninstall enable disable pack check test watch-updates unwatch-updates shexli clean-shexli logs prefs clean

all: schemas

# Compiles schemas in place so `make check` and `make pack` see gschemas.compiled.
schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/*.gschema.xml
	$(GLIB_COMPILE_SCHEMAS) --strict $(SRC)/schemas/

# A checkout installed directly is updated with Gitpulsar Pull, not copied over.
install: schemas
	@test ! -e "$(INSTALL_DIR)/.git" || { echo "Git checkout: use Pull in Gitpulsar instead."; exit 1; }
	mkdir -p "$(INSTALL_DIR)/schemas"
	cp $(SOURCES) "$(INSTALL_DIR)/"
	cp $(SCHEMAS) schemas/gschemas.compiled "$(INSTALL_DIR)/schemas/"
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Now log out and back in (Wayland), then: make enable"

uninstall:
	@test ! -e "$(INSTALL_DIR)/.git" || { echo "Git checkout: disable the extension and manage its checkout separately."; exit 1; }
	-gnome-extensions disable $(UUID)
	rm -rf "$(INSTALL_DIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Syntax-checks every module without a running shell.
check: test
	@for f in $(SRC)/*.js; do \
		node --input-type=module --check < "$$f" >/dev/null 2>&1 && echo "ok   $$f" || { echo "FAIL $$f"; node --input-type=module --check < "$$f"; exit 1; }; \
	done
	@$(GLIB_COMPILE_SCHEMAS) --strict --dry-run $(SRC)/schemas/ && echo "ok   schemas"
	@python3 -c "import json;json.load(open('$(SRC)/metadata.json'))" && echo "ok   metadata.json"

test:
	node --test tests/*.test.mjs
	python3 -m unittest discover -s tests -p '*_test.py'

# Optional, per-user Git checkout watcher. No root privileges or forced logout.
watch-updates:
	python3 tools/update_helper.py install

unwatch-updates:
	python3 tools/update_helper.py uninstall

# Static analysis for extensions.gnome.org packaging and review issues. Runs
# against a freshly packed zip — the actual submission artifact.
shexli: pack | $(SHEXLI_VENV)/.installed
	@$(SHEXLI_VENV)/bin/shexli "$(CURDIR)/$(ZIP)"

# Build the analyzer's virtualenv once, then reuse it. `virtualenv` is not
# assumed present, so the stdlib venv module is used. tree-sitter is held below
# 0.26, which segfaults against shexli's 0.25 JavaScript grammar. The sentinel
# is written only on success, so a failed install is retried rather than left
# half-built. `make clean-shexli` forces a full rebuild.
$(SHEXLI_VENV)/.installed:
	python3 -m venv $(SHEXLI_VENV)
	$(SHEXLI_VENV)/bin/pip install --upgrade pip
	$(SHEXLI_VENV)/bin/pip install --upgrade shexli 'tree-sitter<0.26'
	@touch $@
	@echo "shexli environment ready in $(SHEXLI_VENV)"

clean-shexli:
	rm -rf $(SHEXLI_VENV)

pack: schemas
	rm -f "$(ZIP)"
	zip -q "$(ZIP)" $(SOURCES) $(SCHEMAS) schemas/gschemas.compiled

# Live extension logs. Ctrl-C to stop.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered "media-controls\|MediaControls"

clean:
	rm -f $(SRC)/schemas/gschemas.compiled $(ZIP)



# make shexli          # pack a fresh zip + run shexli against it
# make check shexli    # your literal phrasing: syntax-check, then shexli
# make clean-shexli    # delete the analyzer env to force a rebuild
