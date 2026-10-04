# Chalito beta: lo que debes saber / What to know

[Español](#español) · [English](#english)

---

## Español

Gracias por probar Chalito. Esta es una beta privada: casi todo funciona, pero hay límites que conocemos. Aquí están, sin letra chica.

### Tu compañero
- **Los compañeros son ilustraciones, no modelos 3D.** Cada uno (Chalito, Bruno, Luna, Tito, Canela y Nube) es una imagen animada con cinco expresiones. Los cosméticos se colocan encima. Los modelos 3D con esqueleto llegarán después de la beta.
- **Los cosméticos son solo de apariencia.** Nunca dan ventajas.

### Aprobaciones
- **Las acciones de riesgo ALTO o CRÍTICO se aprueban desde tu teléfono.** El panel de escritorio puede ver todo y aprobar riesgo bajo o medio. En las de riesgo alto verás "Aprueba esta acción desde tu teléfono" y un botón para negarla. La razón: el teléfono confirma con tu passkey (huella o cara) y el escritorio todavía no.

### Claude Code y Codex
- **Claude Code lo instalas tú.** La app de escritorio no lo trae incluido.
  1. Instálalo con el instalador oficial de Anthropic (https://code.claude.com/docs/en/setup).
  2. Después corre `chalito keys set anthropic`, o `chalito claude pin`.
  3. Cuando Claude Code se actualice solo, corre `chalito claude pin` otra vez. Chalito te avisará.
- **Codex con tu plan de ChatGPT ("Sign in with ChatGPT")** solo está disponible para el dueño mientras OpenAI aprueba la integración. Puedes usar Codex con tu propia llave de API.

### Lo que todavía no hemos probado a gran escala
- **No hemos hecho la prueba de carga con 1,000 dispositivos.** Con un grupo pequeño de testers debería ir bien. Si algo se siente lento, avísanos.
- **La página de inicio se genera en cada visita** (todavía no es estática). Puede tardar un poco más en cargar la primera vez.

### Otros detalles
- **Los avisos de "la Mesa empieza pronto"** todavía no llegan por push, WhatsApp ni llamada.
- **Windows puede mostrar una advertencia de SmartScreen** al instalar, al principio, mientras la app gana reputación; macOS te pide confirmar la primera vez que la abres.

**¿Encontraste algo raro?** Escríbenos. Nos ayuda mucho saber qué estabas haciendo y en qué dispositivo.

---

## English

Thanks for trying Chalito. This is a private beta: almost everything works, but there are limits we know about. Here they are, no fine print.

### Your companion
- **Companions are illustrations, not 3D models.** Each one (Chalito, Bruno, Luna, Tito, Canela and Nube) is an animated image with five expressions. Cosmetics are placed on top. Rigged 3D models come after the beta.
- **Cosmetics are looks only.** They never give an advantage.

### Approvals
- **HIGH or CRITICAL risk actions are approved on your phone.** The desktop panel can see everything and approve low or medium risk. For high-risk ones it asks you to approve on your phone, and shows a button to deny. The reason: your phone confirms with your passkey (fingerprint or face), and the desktop doesn't yet.

### Claude Code and Codex
- **You install Claude Code yourself.** The desktop app doesn't bundle it.
  1. Install it with Anthropic's official installer (https://code.claude.com/docs/en/setup).
  2. Then run `chalito keys set anthropic`, or `chalito claude pin`.
  3. When Claude Code updates itself, run `chalito claude pin` again. Chalito will tell you.
- **Codex with your ChatGPT plan ("Sign in with ChatGPT")** is available to the owner only while OpenAI approves the integration. You can use Codex with your own API key.

### What we haven't tested at scale yet
- **We haven't run the 1,000-device load test.** With a small group of testers it should be fine. If anything feels slow, tell us.
- **The landing page is rendered on each visit** (not static yet). It may take a moment longer the first time.

### Other details
- **"Your Mesa starts soon" alerts** don't reach you by push, WhatsApp or call yet.
- **Windows may show a SmartScreen warning** when installing, at first, while the app builds reputation; macOS asks you to confirm the first time you open it.

**Found something odd?** Write to us. It helps a lot to know what you were doing and on which device.
