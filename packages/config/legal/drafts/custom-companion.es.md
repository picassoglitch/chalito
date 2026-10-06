# DRAFT — PENDIENTE REVISIÓN LEGAL

**Crea tu personaje con tu foto: adiciones propuestas al aviso de privacidad y a los términos de Chalito**

Este archivo NO se publica: no lo carga la app (las páginas `/privacidad` y `/terminos` se arman con `../privacy.es.md` y `../terms.es.md`). Es un borrador para que el titular y su abogado lo revisen; cuando lo aprueben, cada bloque se copia a la sección indicada de esos archivos. No es asesoría legal. Lo que va entre corchetes lo decide el abogado o el responsable. Ver `docs/LEGAL_CHECKLIST.md` 5.4.

Nota para el abogado: el aviso de privacidad de Chalyb (el hub) dice hoy que Chalyb "no está dirigido a menores de 18 años". La función de abajo permite de 13 a 17 años con permiso de mamá, papá o tutor, por decisión del titular. Hay que reconciliar ambos textos antes de publicar.

---

## Para el aviso de privacidad

### En "2. Qué datos tratamos", agregar:

- **Foto para crear tu personaje (opcional):** si eliges "Crea tu personaje", subes una foto tuya. La usamos solo como referencia para dibujar tu personaje y la borramos en cuanto termina el dibujo, salga bien o no. No guardamos la foto ni sus metadatos (antes de enviarla quitamos la ubicación y demás datos EXIF).
- **Tu personaje:** los cinco dibujos que resultan (tu personaje en el estilo de Chalito). Son tus datos y los guardamos como tu compañero hasta que los elimines.
- **Registro de cada creación:** cuándo la pediste, si fue gratis o cuántos tokens costó, lo que costó generarla y si terminó, falló o la eliminaste. No contiene la foto ni los dibujos.
- **Confirmaciones al crear tu personaje:** que la foto es tuya, tu rango de edad (13 a 17 años, o 18 o más) y, si tienes de 13 a 17, que tienes permiso de tu mamá, papá o tutor, con la fecha y hora en que lo confirmaste. No pedimos tu fecha de nacimiento.
- **Marca de "personaje gratis ya usado":** un código cifrado de un solo sentido (un hash con clave secreta) calculado a partir del identificador de tu cuenta de Chalyb y de tu correo. No contiene tu correo ni tu identificador, y no se puede revertir para obtenerlos. Ver "Cuánto tiempo los guardamos".

[El abogado confirma si la foto de la cara o el dibujo resultante pueden considerarse datos biométricos o sensibles bajo la LFPDPPP y, en su caso, si se necesita consentimiento expreso y por escrito. Chalito no extrae plantillas faciales ni identifica a nadie: el modelo solo dibuja una caricatura.]

### En "3. Para qué los usamos", agregar a las finalidades principales:

- crear el personaje que pediste a partir de tu foto y mostrarlo como tu compañero;
- evitar que el personaje gratis se use más de una vez por persona.

### En "4. Con quién se comparten", agregar:

- **Google (Gemini API, plan de pago):** para dibujar tu personaje enviamos tu foto (ya sin metadatos) a la API de Gemini de Google, en Estados Unidos. Usamos el plan de pago de la API, en el que, según los términos de Google, el contenido enviado no se usa para entrenar ni mejorar sus modelos. Google procesa la foto solo para generar el dibujo [y puede conservarla por un periodo limitado para detectar abusos, según sus términos: el abogado confirma el plazo y la redacción vigente].

[El abogado define si este envío es una remisión a un encargado o una transferencia, y si requiere consentimiento.]

### En "5. Cuánto tiempo los guardamos", agregar:

- **Tu foto:** se borra en cuanto termina la creación, salga bien o falle. Si algo se interrumpe, una regla automática del almacenamiento la borra a más tardar en 1 día.
- **Tu personaje:** mientras lo conserves. Puedes eliminarlo cuando quieras con "Eliminar mi personaje" (en Ajustes, en "Crea tu personaje"): borramos sus dibujos de inmediato, incluidas las copias de respaldo del almacenamiento, y no se pueden recuperar. Si era tu compañero, vuelve a verse como el personaje de la lista que tenías, también en tus salas y en tu escritorio. También se borra cuando eliminas tu cuenta.
- **Registro de cada creación y confirmaciones al crear tu personaje:** se conservan aunque elimines el personaje, solo para la facturación, la auditoría y para saber que ya usaste el personaje gratis; no incluyen la foto ni los dibujos. Se borran con tu cuenta. [El abogado confirma el fundamento y si debe haber un plazo máximo.]
- **Marca de "personaje gratis ya usado":** se conserva aun después de que elimines tu cuenta, solo para que el personaje gratis no se pueda volver a usar creando una cuenta nueva. No permite identificarte ni recuperar tu correo. [El abogado confirma el fundamento (interés legítimo / prevención de abuso) y si debe tener un plazo máximo.]

### Nueva sección "Menores de edad" (o agregar a la existente):

Para crear un personaje con tu foto necesitas tener al menos 13 años. Si tienes de 13 a 17 años, necesitas el permiso de tu mamá, papá o tutor, y nos lo confirmas antes de crear tu personaje. Si tienes menos de 13 años, no puedes usar esta función. Si eres mamá, papá o tutor y crees que un menor a tu cargo creó un personaje sin tu permiso, escríbenos a [canal ARCO] y lo borraremos.

[El abogado confirma si la autoafirmación basta en México y en los demás mercados, o si se necesita verificar el consentimiento de los padres.]

---

## Para los términos de uso

### En "4. Uso aceptable", agregar:

- **Fotos para crear tu personaje:** solo puedes subir una foto tuya, en la que aparezcas tú. No subas fotos de otras personas (incluidos tus hijos u otros menores), de famosos o de personajes de terceros. Al crear tu personaje confirmas que la foto es tuya y tu rango de edad.

### En "5. Compras en la tienda" (o una sección nueva "Crea tu personaje"), agregar:

- **Tu primer personaje es gratis, una vez por persona.** "Por persona" significa que eliminar tu cuenta y crear otra (con la misma cuenta de Chalyb o el mismo correo) no da otro personaje gratis.
- **Los siguientes cuestan tokens de Chalyb.** El precio se muestra en tokens antes de crear, y se basa en lo que cuesta generar los cinco dibujos con el proveedor (hoy: 5 imágenes de Gemini a [US$0.067] cada una) más el margen de Chalyb. Con la configuración actual son [217,750 tokens] por personaje. [El abogado y el titular confirman cómo se expresa el precio y si debe mostrarse también en pesos.]
- **Si la creación falla, no se cobra.** Solo se cobra un personaje terminado.
- **Puedes eliminar tu personaje cuando quieras** ("Eliminar mi personaje"). Es permanente: sus dibujos se borran y no se pueden recuperar. Eliminarlo no devuelve los tokens que costó ni la creación gratis (si era tu personaje gratis, el siguiente se cobra). No se puede eliminar mientras se está dibujando: espera a que termine.
- Puedes crear hasta 5 personajes al día.

### En "6. Contenido generado con IA", agregar:

- Tu personaje lo dibuja un modelo de IA (Google Gemini) a partir de tu foto. Puede no parecerse a ti o tener errores. [El abogado define qué derechos tienes sobre el dibujo resultante.]
