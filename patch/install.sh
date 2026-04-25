#!/usr/bin/env bash
# install.sh — apply all token-dashboard patches
# Run from the project root that contains this patch/ folder:
#   bash patch/install.sh /path/to/token-dashboard

set -euo pipefail

PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
DASH="${1:-}"

# ── locate dashboard ──────────────────────────────────────────────────────────
if [[ -z "$DASH" ]]; then
  # Try common locations
  for candidate in \
    "$HOME/developer/token-dashboard" \
    "$HOME/dev/token-dashboard" \
    "$(pwd)/token-dashboard"; do
    if [[ -f "$candidate/web/app.js" ]]; then DASH="$candidate"; break; fi
  done
fi

if [[ -z "$DASH" || ! -f "$DASH/web/app.js" ]]; then
  echo "❌  Could not find token-dashboard. Pass the path as the first argument:"
  echo "    bash patch/install.sh /path/to/token-dashboard"
  exit 1
fi

echo "📂  Dashboard found at: $DASH"
echo ""

# ── backup ────────────────────────────────────────────────────────────────────
BACKUP="$DASH/.patch-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP/web/routes"
for f in web/app.js web/routes/prompts.js web/routes/tips.js web/style.css; do
  [[ -f "$DASH/$f" ]] && cp "$DASH/$f" "$BACKUP/$f" && echo "  backed up $f"
done
echo "💾  Originals backed up to: $BACKUP"
echo ""

# ── copy new/replaced files ───────────────────────────────────────────────────
echo "📋  Copying patched files..."

# Core app files
cp "$PATCH_DIR/web/app.js"              "$DASH/web/app.js"
echo "  ✓  web/app.js  (added /limits route, /home+/limits to RAIL_ROUTES, SSE strip)"

cp "$PATCH_DIR/web/routes/prompts.js"  "$DASH/web/routes/prompts.js"
echo "  ✓  web/routes/prompts.js  (filter chips: model + cache-hit%)"

cp "$PATCH_DIR/web/routes/tips.js"     "$DASH/web/routes/tips.js"
echo "  ✓  web/routes/tips.js  (card grid: severity dot + savings + Show me)"

# New files
cp "$PATCH_DIR/web/routes/limits.js"   "$DASH/web/routes/limits.js"
echo "  ✓  web/routes/limits.js  (new Limits tab)"

cp "$PATCH_DIR/web/pace-history.js"    "$DASH/web/pace-history.js"
echo "  ✓  web/pace-history.js  (localStorage pace tracker)"

echo ""

# ── append CSS additions ──────────────────────────────────────────────────────
CSS_MARKER="/* patch:style-additions */"
if grep -q "$CSS_MARKER" "$DASH/web/style.css" 2>/dev/null; then
  echo "  ℹ️   style-additions already appended — skipping CSS"
else
  echo "" >> "$DASH/web/style.css"
  echo "$CSS_MARKER" >> "$DASH/web/style.css"
  cat "$PATCH_DIR/web/style-additions.css" >> "$DASH/web/style.css"
  echo "  ✓  web/style.css  (appended filter chips, tip cards, limits, pace bar styles)"
fi

echo ""

# ── optional: copy widget for CodexBar ───────────────────────────────────────
WIDGET_SRC="$PATCH_DIR/../Limits Widget.html"
if [[ -f "$WIDGET_SRC" ]]; then
  cp "$WIDGET_SRC" "$DASH/web/limits-widget.html"
  echo "  ✓  web/limits-widget.html  (CodexBar WebView embed)"

  # Check if server.py serves arbitrary web/ files or needs a route
  if grep -q "limits.widget\|limits-widget" "$DASH/token_dashboard/server.py" 2>/dev/null; then
    echo "  ℹ️   server.py already has limits-widget route"
  else
    echo "  ⚠️   Add a static route for /web/limits-widget.html in server.py if needed"
    echo "      (most setups serve all web/ files automatically)"
  fi
fi

echo ""

# ── verify ────────────────────────────────────────────────────────────────────
echo "🔍  Verifying install..."
ERRORS=0
for f in \
  "web/app.js" \
  "web/routes/prompts.js" \
  "web/routes/tips.js" \
  "web/routes/limits.js" \
  "web/pace-history.js"; do
  if [[ -f "$DASH/$f" ]]; then
    echo "  ✓  $f"
  else
    echo "  ✗  $f MISSING"
    ERRORS=$((ERRORS+1))
  fi
done

# Check key markers
if grep -q "'/limits'" "$DASH/web/app.js"; then
  echo "  ✓  /limits route present in app.js"
else
  echo "  ✗  /limits route NOT found in app.js"
  ERRORS=$((ERRORS+1))
fi

if grep -q "'/home'.*RAIL\|RAIL.*'/home'" "$DASH/web/app.js" || grep -q "'/home'" "$DASH/web/app.js"; then
  echo "  ✓  /home in RAIL_ROUTES"
fi

if grep -q "filter-chips-bar" "$DASH/web/routes/prompts.js"; then
  echo "  ✓  filter chips present in prompts.js"
fi

if grep -q "tip-card-grid" "$DASH/web/routes/tips.js"; then
  echo "  ✓  card grid present in tips.js"
fi

if grep -q "filter-chips-bar" "$DASH/web/style.css"; then
  echo "  ✓  CSS additions present in style.css"
fi

echo ""
if [[ $ERRORS -eq 0 ]]; then
  echo "✅  All done! Restart the dashboard server to pick up changes:"
  echo "    cd $DASH && python cli.py"
  echo ""
  echo "    Then open http://localhost:PORT/#/limits"
  echo "    and http://localhost:PORT/#/home to see the limits strip."
else
  echo "⚠️   $ERRORS error(s) found. Check the output above."
  echo "    Originals are backed up at: $BACKUP"
fi
