# Put it online (Render, step by step)

What you get: a web address your team opens, sign-in, saved releases, and auto-refresh and Slack alerts that run all the time.
Cost: Render's Starter plan (about $7 a month) because the app needs a disk to remember data. The free plan forgets everything when it restarts, so do not use it for real work.

## Before you start
- The code is on GitHub: `moeramen112/releasedoclogin`.
- A Render account (render.com). Sign up with GitHub.
- Your work email, for the first admin.

## Steps
1. In Render click **New**, then **Blueprint**.
2. Pick the `releasedoclogin` repository and click **Connect**.
3. Render reads `render.yaml` and shows the settings. It asks for values:
   - `ADMIN_EMAIL`: your email. This becomes the first admin.
   - `PUBLIC_URL`: leave blank for now. You fill it in at step 6.
   - Jira, Slack, GitHub values: fill in if you have them. Blank is fine. You can add them later.
4. Click **Apply**. Wait for the build to say **Live** (a few minutes).
5. Copy your site address from the top of the page. It looks like `https://release-readiness-xxxx.onrender.com`.
6. Go to **Environment**, set `PUBLIC_URL` to that address, and save. Render restarts the app.
7. Go to **Logs**. Look for the line that says **First admin created for you@...** followed by a link. Open that link once and choose your password. It works for 7 days.
8. Sign in. Open **People** and invite your team. Each invite makes a one-time link. Send it to them yourself.

## Check it works
- Open `https://your-address/api/health`. You should see `{"ok":true}`.
- Make a release, close the tab, open it from another device. It should still be there.
- Restart the service in Render. Your releases should still be there. If they are gone, the disk is not attached.

## If something goes wrong
- **Link in the logs is missing:** it only prints the first time. Delete nothing. In Render **Shell**, run `ls /data`. If `users.json` exists, add `RESEND_ADMIN_LINK` = `1` in Environment, save, and read the Logs again for a fresh link. Remove it afterwards.
- **Cannot sign in over https:** `COOKIE_SECURE` and `TRUST_PROXY` are already set to 1 in the Dockerfile. Check `PUBLIC_URL` starts with `https://`.
- **Slack or Jira does nothing:** check the three Jira values and the Slack webhook in Environment, then open a release and tick the auto-refresh box.

## Other hosts
The `Dockerfile` works on Railway, Fly.io or any server that runs Docker. Mount a disk at `/data` and set the same values.

## Back up
Everything is in `/data` (users, releases, audit log). Take a disk snapshot in Render now and then.
