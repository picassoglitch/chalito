# DRAFT — PENDIENTE REVISIÓN LEGAL (pending legal review)

**Create your character from your photo: proposed additions to Chalito's privacy notice and terms**

This file is NOT published: the app doesn't load it (`/privacidad` and `/terminos` are built from `../privacy.en.md` and `../terms.en.md`). It's a draft for the owner and counsel to review; once approved, each block is copied into the named section of those files. The Spanish version (`custom-companion.es.md`) is the primary text. This is not legal advice. Bracketed items are for counsel or the controller to decide. See `docs/LEGAL_CHECKLIST.md` 5.4.

Note for counsel: Chalyb's (the hub's) privacy notice currently says Chalyb "is not directed to minors under 18". The feature below allows 13–17 with a parent's or guardian's permission, per the owner's decision. Both texts must be reconciled before publishing.

---

## For the privacy notice

### Add to "2. What data we process":

- **Photo to create your character (optional):** if you choose "Create your character", you upload a photo of yourself. We use it only as a reference to draw your character and delete it as soon as the drawing is done, whether it worked or not. We don't keep the photo or its metadata (location and other EXIF data are removed before it's sent).
- **Your character:** the five resulting drawings (you, in Chalito's style). They're your data and we keep them as your companion.
- **What you confirm when creating your character:** that the photo is of you, your age range (13 to 17, or 18 or older) and, if you're 13 to 17, that you have permission from your mom, dad or guardian, with the date and time you confirmed it. We don't ask for your date of birth.
- **"Free character already used" marker:** a one-way code (a keyed hash) computed from your Chalyb account identifier and your email. It doesn't contain your email or identifier, and can't be reversed to get them. See "How long we keep it".

[Counsel to confirm whether the face photo or the resulting drawing can be biometric or sensitive data under the LFPDPPP (and GDPR, if the EU is served) and, if so, whether express written consent is needed. Chalito extracts no face templates and identifies no one: the model only draws a cartoon.]

### Add to "3. What we use it for", primary purposes:

- creating the character you asked for from your photo and showing it as your companion;
- making sure the free character is used only once per person.

### Add to "4. Who it's shared with":

- **Google (Gemini API, paid tier):** to draw your character we send your photo (with metadata removed) to Google's Gemini API, in the United States. We use the API's paid tier, under which, per Google's terms, submitted content isn't used to train or improve its models. Google processes the photo only to generate the drawing [and may keep it for a limited period for abuse monitoring under its terms: counsel to confirm the current period and wording].

[Counsel to decide whether this is a disclosure to a processor (remisión) or a transfer, and whether it needs consent.]

### Add to "5. How long we keep it":

- **Your photo:** deleted as soon as the creation ends, whether it succeeded or failed. If something is interrupted, an automatic storage rule deletes it within 1 day at most.
- **Your character:** for as long as you keep it. It's deleted when you delete it or delete your account.
- **What you confirmed when creating your character:** kept with that creation's record; deleted with your account.
- **"Free character already used" marker:** kept even after you delete your account, only so the free character can't be used again by creating a new account. It can't identify you or recover your email. [Counsel to confirm the basis (legitimate interest / abuse prevention) and whether it needs a maximum period.]

### New section "Minors" (or add to the existing one):

You must be at least 13 to create a character from your photo. If you're 13 to 17, you need permission from your mom, dad or guardian, and you confirm that before creating your character. If you're under 13, you can't use this feature. If you're a parent or guardian and believe a minor in your care created a character without your permission, write to [ARCO channel] and we'll delete it.

[Counsel to confirm whether self-attestation is enough in Mexico and the other markets served, or whether verifiable parental consent is required.]

---

## For the terms of use

### Add to "4. Acceptable use":

- **Photos for your character:** only upload a photo of yourself, showing you. Don't upload photos of other people (including your children or other minors), celebrities or third-party characters. When you create your character you confirm the photo is of you and your age range.

### Add to "5. Store purchases" (or a new "Create your character" section):

- **Your first character is free, once per person.** "Per person" means that deleting your account and creating another one (with the same Chalyb account or the same email) doesn't give another free character.
- **Later ones cost Chalyb tokens.** The price is shown in tokens before you create, and is based on what generating the five drawings costs with the provider (today: 5 Gemini images at [US$0.067] each) plus Chalyb's margin. With the current configuration that's [217,750 tokens] per character. [Counsel and owner to confirm how the price is expressed and whether it must also be shown in pesos.]
- **If a creation fails, you're not charged.** Only a finished character is charged.
- You can create up to 5 characters a day.

### Add to "6. AI-generated content":

- Your character is drawn by an AI model (Google Gemini) from your photo. It may not look like you or may have mistakes. [Counsel to define what rights you have over the resulting drawing.]
