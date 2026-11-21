// Presentation-only theme preference. No backend state is touched.
const THEME_KEY = "tuya-local-key-theme";

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY) || "system"; }
  catch (error) { return "system"; }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  for (const button of document.querySelectorAll("[data-theme-option]")) {
    button.setAttribute("aria-pressed", button.dataset.themeOption === theme ? "true" : "false");
  }
}

applyTheme(storedTheme());

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(storedTheme());
  for (const button of document.querySelectorAll("[data-theme-option]")) {
    button.addEventListener("click", () => {
      const theme = button.dataset.themeOption;
      applyTheme(theme);
      try { localStorage.setItem(THEME_KEY, theme); } catch (error) { /* private mode */ }
    });
  }
});
