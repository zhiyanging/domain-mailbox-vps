const defaults = {
  title: "Digital Infrastructure",
  headline: "Reliable digital infrastructure for modern teams.",
  description: "Secure, resilient services designed for dependable digital operations.",
};

fetch("/site-config.json", { headers: { Accept: "application/json" } })
  .then((response) => response.ok ? response.json() : defaults)
  .catch(() => defaults)
  .then((config) => {
    const value = { ...defaults, ...(config || {}) };
    document.title = value.title;
    document.querySelector("meta[name='description']")?.setAttribute("content", value.description);
    document.querySelector("#siteTitle").textContent = value.title;
    document.querySelector("#footerTitle").textContent = value.title;
    document.querySelector("#siteHeadline").textContent = value.headline;
    document.querySelector("#siteDescription").textContent = value.description;
  });
