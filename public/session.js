// Shows who is signed in on every page, with links to People (admins), the account page, and Sign out.
(async () => {
  try {
    const res = await fetch("/api/auth/me");
    if (res.status === 401) { location.replace("/login.html?next=" + encodeURIComponent(location.pathname)); return; }
    const me = await res.json();
    window.__ME = me;
    // Count of things waiting for approval, shown next to the Inbox link on every page.
    fetch("/api/agent").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      window.__INBOX = d.openCount;
      document.querySelectorAll("[data-inbox]").forEach((a) => { a.textContent = d.openCount ? `Inbox (${d.openCount})` : "Inbox"; });
    }).catch(() => {});
    if (me.authEnabled === false) return;
    const nav = document.querySelector(".top .nav");
    if (!nav) return;
    const box = document.createElement("div");
    box.className = "who";
    const label = document.createElement("span");
    label.className = "mono";
    label.textContent = `${me.name || me.email} · ${me.role}`;
    box.append(label);
    const link = (href, text) => { const a = document.createElement("a"); a.href = href; a.textContent = text; return a; };
    if (me.role === "admin") {
      const a = link("/admin.html", "People");
      if (location.pathname === "/admin.html") a.setAttribute("aria-current", "page");
      nav.append(a);
    }
    box.append(link("/account.html", "Password"));
    const out = document.createElement("button");
    out.className = "btn small"; out.type = "button"; out.textContent = "Sign out";
    out.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST", headers: { "X-Requested-With": "release-readiness" } });
      location.assign("/login.html");
    });
    box.append(out);
    nav.after(box);
  } catch { /* the page still works; the server enforces access either way */ }
})();
