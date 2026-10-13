Hosted capture service

Build from work:
 docker build -f competitor-hosted-runner/Dockerfile -t competitive-ux-runner .

Deploy behind HTTPS with persistent /data and one replica. Inject server-only
CAPTURE_SERVICE_TOKEN (32+ characters), OPENROUTER_API_KEY, OPENROUTER_MODEL.
The Worker needs CAPTURE_SERVICE_URL and the same service token.

The launcher starts an included loopback HTTP/CONNECT proxy. It resolves DNS
once per connection and connects to the validated numeric public IPv4 address.
Private, reserved, documentation and mixed public/private IPv4 answers fail
closed; IPv6-only sites are unsupported. Only ports 80/443 are accepted.
Cross-domain public assets are allowed; top-level navigation remains scoped
by the recorder. Chromium gets this proxy with loopback bypass and QUIC disabled.
No external proxy or per-asset host list is needed by this launcher.

This is browser proxy enforcement, not an OS network sandbox. Production
infrastructure should additionally deny direct browser egress and limit CPU,
memory, disk and retention. Native/WebRTC transports outside HTTP interception
are not claimed as captured or protected by the proxy.

All /v1 routes require Bearer auth. Stable UUID jobs are idempotent; capture
folders are immutable. Interrupted runs fail after service restart.
The image uses the frozen pnpm lock and a shared browser installation readable
by the non-root node user. The image itself has not been built in this session.
No provider or browser was invoked in tests. Hosting, secrets, HTTPS, persistent
storage and live acceptance remain required before claiming a working service.
