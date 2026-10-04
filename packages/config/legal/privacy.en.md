# Chalito privacy notice

**DRAFT, pending legal review.** This text is a working template that follows `docs/LEGAL_CHECKLIST.md`. It isn't legal advice and isn't the final notice. Items in brackets are for counsel or the controller to decide.

Last updated: [date].

## 1. Who is responsible for your data

[Name or legal entity of the controller: Chalyb or the owner's entity], at [address], is responsible for processing your personal data under Mexico's Federal Law on the Protection of Personal Data Held by Private Parties (LFPDPPP).

Chalito is a service that runs inside Chalyb: your account, sign-in, payments, free trials and invoices are handled by Chalyb. [State whether this notice is Chalito's own or a section of Chalyb's.]

## 2. What data we process

- **Account:** your Chalyb account identifier, language, time zone and preferences.
- **Devices:** each device's name, its public keys and fingerprints, whether it's online and when it was last seen. Private keys stay on your devices.
- **Phone:** your number (if you add it for calls, SMS or WhatsApp), its country and when you verified it.
- **Your agents' activity:** metadata about sessions, approvals and notifications (status, risk level, times). The content of requests and sessions is end-to-end encrypted between your devices.
- **Security log:** important actions on your account, such as pairing or revoking devices and approving connections.
- **Voice:** on calls, audio goes directly between your device and the voice provider; it doesn't pass through Chalito's servers.
- **Call briefing:** if you turn on "call briefing", the lines read aloud leave your computer unencrypted so they can be read.
- **Cards shared with connected apps:** if you turn it on, a session's card is stored unencrypted so the connected app can read it.
- **Usage:** tokens used per day, for your usage page and for billing.

[Counsel confirms the full list of categories and whether any are sensitive data.]

## 3. What we use it for

**Primary purposes** (needed for the service):
- giving you access and keeping your account secure;
- connecting your devices and bringing your approvals to your computers;
- alerting you in the app, by SMS, WhatsApp or call when something needs your attention, if you turned it on;
- measuring and billing usage.

**Secondary purposes:** [none / list]. [How to refuse the secondary ones.]

## 4. Who it's shared with (processors and transfers)

We use these providers to run the service. Some are in the United States:

- **Supabase:** database and sign-in.
- **Google Cloud:** servers, queues and storage. Google AI (Gemini) and Vertex are used for some companion replies.
- **Vercel:** website.
- **Twilio:** calls, SMS and phone verification.
- **Meta:** WhatsApp messages.
- **OpenAI, Anthropic, xAI and Google AI:** artificial intelligence models. They only receive what you or your agents send. If you use your own keys, those calls leave from your device.

[Counsel sets the basis for each transfer, whether it needs consent, and the contracts with each processor.]

## 5. How long we keep it

- Ephemeral room messages: 24 hours by default (the room's creator can choose another period).
- Voice call references: 1 hour.
- Usage records already sent for billing: 30 days.
- Session events: [period].
- Security log: [period to be decided].
- Your account: while it exists; deleting it removes its data in cascade.

## 6. Your ARCO rights

You can request **access, rectification, cancellation or opposition** regarding your data, and withdraw your consent, by writing to [email or ARCO channel]. We'll answer within 20 business days, after confirming your identity [method].

[Account deletion: the path to request it isn't built in the app yet.]

## 7. Changes to this notice

If this notice changes, we'll publish it on this page with its new date and let you know in the app.

## 8. Users outside Mexico

[Decide: a GDPR notice for European Union users, or not offering the service there.]
