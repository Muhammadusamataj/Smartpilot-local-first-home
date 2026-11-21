// Presentation-only palette preference. No backend state is touched.
const PALETTE_KEY = "tuya-local-key-palette";
const PALETTES = new Set(["midnight", "frost", "rose"]);

function storedPalette() {
  try {
    const value = localStorage.getItem(PALETTE_KEY) || "midnight";
    return PALETTES.has(value) ? value : "midnight";
  } catch (error) { return "midnight"; }
}

function applyPalette(palette) {
  const value = PALETTES.has(palette) ? palette : "midnight";
  if (value === "midnight") document.documentElement.removeAttribute("data-palette");
  else document.documentElement.dataset.palette = value;
  for (const button of document.querySelectorAll("[data-palette-option]")) {
    button.setAttribute("aria-pressed", button.dataset.paletteOption === value ? "true" : "false");
  }
}

applyPalette(storedPalette());

document.addEventListener("DOMContentLoaded", () => {
  applyPalette(storedPalette());
  for (const button of document.querySelectorAll("[data-palette-option]")) {
    button.addEventListener("click", () => {
      const palette = button.dataset.paletteOption;
      applyPalette(palette);
      try { localStorage.setItem(PALETTE_KEY, palette); } catch (error) { /* private mode */ }
    });
  }
});
