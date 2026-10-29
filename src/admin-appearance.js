// Only non-sensitive appearance preferences are persisted. Never store credentials.
export function normalizeAppearance(value) {
  const input = value && typeof value === "object" ? value : {};
  const choices = {
    theme: ["system", "light", "dark"],
    accent: ["green", "blue", "purple", "orange"],
    font: ["standard", "small", "large", "extra-large"],
    density: ["comfortable", "compact"],
  };
  return Object.fromEntries(Object.entries(choices).map(([key, options]) =>
    [key, options.includes(input[key]) ? input[key] : options[0]]));
}

// Self-contained so it can be served with the existing CSP-safe external script.
export function initAppearance(normalize) {
  const key = "current.admin.appearance.v1";
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preferences;
  try { preferences = normalize(JSON.parse(window.localStorage.getItem(key))); }
  catch { preferences = normalize(null); }
  function apply() {
    root.dataset.theme = preferences.theme === "system" ? (system.matches ? "dark" : "light") : preferences.theme;
    root.dataset.accent = preferences.accent;
    root.dataset.font = preferences.font;
    root.dataset.density = preferences.density;
    for (const name of ["theme", "accent", "font", "density"]) $("appearance-" + name).value = preferences[name];
  }
  function save() {
    apply();
    try {
      window.localStorage.setItem(key, JSON.stringify(preferences));
      $("appearance-status").textContent = "外观偏好已保存，仅影响当前浏览器。";
    } catch {
      $("appearance-status").textContent = "浏览器不允许保存设置；当前页面仍会应用这些偏好。";
    }
  }
  apply();
  system.addEventListener("change", () => { if (preferences.theme === "system") apply(); });
  for (const name of ["theme", "accent", "font", "density"]) {
    $("appearance-" + name).addEventListener("change", event => {
      preferences = normalize({ ...preferences, [name]: event.target.value });
      save();
    });
  }
  $("appearance-open").addEventListener("click", () => $("appearance").showModal());
  for (const id of ["appearance-close", "appearance-done"]) $(id).addEventListener("click", () => $("appearance").close());
  $("appearance-reset").addEventListener("click", () => { preferences = normalize(null); save(); });
  window.addEventListener("storage", event => {
    if (event.key !== key && event.key !== null) return;
    try { preferences = normalize(JSON.parse(event.newValue)); }
    catch { preferences = normalize(null); }
    apply();
  });
}
