# Third-party notices

The host build includes the Codex, Antigravity and Claude connection modules
from `@eddyskywalker/dsh-chatgpt-subscription` 0.42.0, MIT licensed, copyright
(c) 2026 DSH ChatGPT Subscription contributors. Original license: UPSTREAM_LICENSE.
Source: https://github.com/Aa728848/dsh-chatgpt-subscription
Revision: 1939b2f63a7dfa8b4525f941d51d698189715a9c (npm 0.42.0 gitHead / v0.42.0).

The selected modules are bundled from their original sources. Their OAuth,
credential storage, provider request construction and request controls are
not modified. This package supplies its own composition and settings UI. It
does not mount the upstream plugin's global tool, search, preset synchronization
or delegation-policy extensions. Native DSH authorization remains in effect.

DSH / Cordis / Schemastery and React are supplied by the host. Runtime dependency
licenses for undici and zod accompany their installed npm packages. These
licenses do not imply endorsement by OpenAI, Google or Anthropic. The three
providers' accounts, subscriptions, usage conditions and availability are
controlled by their respective services. Community subscription connections
are not a promise of official third-party support or continued account access.
