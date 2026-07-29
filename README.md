# مدرسة سيد الأوصياء الدينية — Sayyid al-Awsiya Religious School

Bilingual (Arabic / English) website for the seminary school in Najaf al-Ashraf, with an
online admission form that submits directly into the school's existing Google Form responses
sheet.

## Structure

```
index.html          markup for every section (Arabic is the default language)
assets/styles.css   design system — colours, typography, RTL/LTR layout
assets/i18n.js      all copy, in Arabic and English
assets/app.js       language toggle, navigation, form validation, form submission
```

No build step and no dependencies. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Language

Arabic (RTL) is the default. The header toggle switches to English (LTR); the choice is
remembered in `localStorage`. All copy lives in `assets/i18n.js` under the `ar` and `en`
objects — edit text there, not in `index.html`. Each translatable element in the HTML carries
a `data-i18n="key"` attribute matching a key in both dictionaries.

## The admission form

The form posts to the school's existing Google Form, so responses continue to arrive in the
same spreadsheet as before:

- Form: `https://forms.gle/iREfYcL5WxHjeZacA`
- Endpoint: set as `FORM_ACTION` in `assets/app.js`

Each input's `name` attribute is the Google Form field ID:

| Field | Entry ID |
|---|---|
| الاسم الرباعي واللقب / Full name and title | `entry.1626171286` |
| مكان التولد / Place of birth | `entry.615586237` |
| سنة التولد / Year of birth | `entry.1002684952` |
| البلد / Country | `entry.1969650934` |
| رقم الهاتف (واتساب) / Phone (WhatsApp) | `entry.1898730539` |
| الحالة الاجتماعية / Marital status | `entry.1906618117` |
| عدد الأطفال / Number of children | `entry.457932636` |
| مدة الاقامة / Duration of residence | `entry.792268296` |
| رقم الاقامة / Residence number | `entry.1139343288` |
| رقم جواز السفر / Passport number | `entry.1068263183` |
| التحصيل الاكاديمي / Academic qualifications | `entry.2005157771` |
| المعرف الاول / First reference | `entry.68488186` |
| رقم هاتف المعرف الاول / First reference phone | `entry.569017037` |
| المعرف الثاني / Second reference | `entry.1679801755` |
| رقم هاتف المعرف الثاني / Second reference phone | `entry.1694902936` |

Notes:

- Marital status is always submitted with the Arabic values `اعزب` / `متزوج`, whichever
  language the visitor is using, because those are the option values Google Forms expects.
- Submission goes through a hidden `iframe`, since Google Forms does not allow a cross-origin
  response to be read. The request reaches the sheet; the response is discarded. The success
  screen therefore confirms the request was sent, not that Google accepted it.
- If the Google Form is ever edited, re-check the entry IDs — Google assigns new ones for new
  questions.

## Editing common content

| What | Where |
|---|---|
| Any visible text | `assets/i18n.js` |
| Registration dates | keys `dateFrom`, `dateTo`, `dateYear`, `contactHours` |
| WhatsApp number | `index.html` — the `wa.me` link, and the displayed number next to it |
| Address | key `contactAddr` |
| Colours and fonts | `:root` in `assets/styles.css` |

After editing a CSS or JS file, bump the `?v=1` query on its `<link>`/`<script>` tag in
`index.html` so returning visitors do not get a cached copy.

## Deployment

The site is static and can be hosted anywhere.

### GitHub Pages

Currently live at <https://hbgladiatorx.github.io/najafschool/>. Configured under repository
**Settings → Pages → Source: Deploy from a branch → `main` / `root`**.

### Own server (www.najaf.school)

One-time server preparation — installs nginx, configures the site and obtains a Let's Encrypt
certificate. Copy the script to the server and run it there:

```bash
scp server-setup.sh USER@HOST:~
ssh USER@HOST 'CERT_EMAIL=you@example.com sudo -E bash server-setup.sh'
```

Then, from this machine, copy `deploy.env.example` to `deploy.env`, fill in the server
details, and upload:

```bash
./deploy.sh --dry-run   # preview
./deploy.sh             # upload
```

`deploy.sh` uses `rsync --delete`, so the remote web root ends up mirroring this repository
exactly — anything else in that directory is removed. `deploy.env` is git-ignored.

Prerequisites for the certificate step: `najaf.school` and `www.najaf.school` must already
resolve to the server, and ports 80 and 443 must be open to the internet (on AWS this means
the instance's **security group**, in addition to any firewall on the host).
