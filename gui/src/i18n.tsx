import React, { createContext, useContext, useMemo } from 'react';

/* Ronin Code — bilingual EN/FA string dictionary.
   Every user-facing string in the GUI lives here. Technical content
   (code, paths, model ids, URLs, user/model text) is never translated. */

export type Lang = 'en' | 'fa';

const en = {
  'app.tagline': 'Describe it in plain words. Ronin Code builds it, and you watch it appear — live, on the right.',
  'app.whatBuild': 'What do you want to build?',
  'app.openProject': 'Open project',
  'app.createStarter': 'Create starter project',
  'app.noProjectYet': 'No project yet',
  'app.settings': 'Settings',
  'app.live': 'Live',
  'app.previewMode': 'Preview mode',
  'app.previewNote': 'Preview mode — add an API key in Settings to go live.',
  'app.previewHeroNote': 'Preview mode — add an API key in Settings to go live.',
  'app.composerPlaceholder': 'Describe what to build…',
  'app.composerHint': 'Enter to send · Shift + Enter for a new line',
  'app.send': 'Send',
  'app.dismiss': 'Dismiss',
  'app.undoFailed': 'Undo could not be completed.',
  'app.openProjectPrompt': 'Path to your project folder',
  'app.openProjectFailed': 'Could not open that project.',
  'app.starterFailed': 'Could not create a starter project.',
  'app.turnStartFailed': 'Could not start that turn.',
  'app.genericTurnError': 'Something went wrong during that turn.',
  'app.previewWillAppear': 'Your creation will appear here',
  'app.previewEmptySub': 'Open a project, or create a starter — it renders live in this space.',
  'app.refreshPreview': 'Refresh preview',
  'app.collapsePreview': 'Collapse preview',
  'app.showPreview': 'Show preview',
  'app.auto': 'Auto',
  'app.autoOn': 'Auto is on — everything runs without asking',
  'app.autoOff': 'Auto is off — Ronin asks before commands and outside changes',
  'app.plan': 'Plan',
  'app.planOn': 'Plan mode is on — you approve a plan before building',
  'app.planOff': 'Plan mode',
  'app.idea': 'Idea',
  'app.publish': 'Publish',
  'app.checkpoints': 'Checkpoints',
  'app.example1': 'Add a dark hero section with a signup form',
  'app.example2': 'Make the layout responsive',
  'app.example3': 'Add a small todo app section',

  'mode.previewBadge': 'Preview mode — add an API key in Settings to go live.',

  'changes.title': 'Changes from this turn',
  'changes.filesChanged': '{count} file{plural} changed',
  'changes.new': '{count} new',
  'changes.edited': '{count} edited',
  'changes.undo': 'Undo',
  'changes.undoing': 'Undoing…',
  'changes.undone': 'Undone',
  'changes.details': 'Details',
  'changes.diff': 'Diff',
  'changes.checkpoint': 'Save checkpoint',
  'changes.checkpointName': 'Name this checkpoint',
  'changes.largeFile': 'Large file — diff not shown',

  'approval.titleCommand': 'Run this command?',
  'approval.titleWrite': 'Write outside the project?',
  'approval.allow': 'Allow',
  'approval.deny': 'Deny',
  'approval.command': 'Command',
  'approval.path': 'Path',
  'approval.hint': 'Turn on Auto in the header to skip these checks.',

  'plan.title': 'Plan',
  'plan.approve': 'Approve & build',
  'plan.reject': 'Discard',
  'plan.editHint': 'Want changes? Just reply in the chat — the plan updates.',
  'plan.building': 'Building your plan…',

  'idea.title': 'Start from an idea',
  'idea.subtitle': 'One line is enough. Ronin shapes it into a product — audience, features and a build plan.',
  'idea.placeholder': 'e.g. A booking app for barbers in my city…',
  'idea.mature': 'Shape my idea',
  'idea.thinking': 'Shaping…',
  'idea.audience': 'Who it is for',
  'idea.pain': 'Their problem',
  'idea.features': 'What it includes',
  'idea.plan': 'Build plan',
  'idea.buildIt': 'Build it',
  'idea.again': 'Start over',
  'idea.previewNote': 'Preview mode — connect a provider key to build for real.',

  'publish.title': 'Publish your project',
  'publish.zip': 'Download project (.zip)',
  'publish.dist': 'Export static copy (dist/)',
  'publish.distDone': 'Static copy exported to dist/ — {count} files.',
  'publish.nextTitle': 'What to do next',
  'publish.step1': 'Pick a host: any static host works (your own server, Netlify, Vercel, GitHub Pages…).',
  'publish.step2': 'Upload the contents of the dist/ folder (or unzip the download there).',
  'publish.step3': 'Buy a domain from any registrar and point its DNS to your host.',
  'publish.step4': 'Turn on HTTPS in your host’s panel — usually one click, free via Let’s Encrypt.',
  'publish.step5': 'Share the link. Your site is live.',

  'checkpoints.title': 'Checkpoints',
  'checkpoints.empty': 'No checkpoints yet. Save one before a big change.',
  'checkpoints.save': 'Save checkpoint',
  'checkpoints.restore': 'Restore',
  'checkpoints.restored': 'Restored “{name}”.',
  'checkpoints.namePlaceholder': 'e.g. Before redesign',

  'cost.session': 'Session',
  'cost.thisTurn': 'This turn',
  'cost.est': 'est.',
  'cost.budgetWarn': 'You are close to your budget cap.',
  'cost.budgetHit': 'Budget cap reached — turns are paused. Raise it in Settings.',

  'settings.title': 'Settings',
  'settings.close': 'Close settings',
  'settings.provider': 'Provider',
  'settings.noProviders': 'No providers available',
  'settings.endpointUrl': 'Endpoint URL',
  'settings.endpointHint': 'Any OpenAI-compatible endpoint — Ronin talks to it directly.',
  'settings.apiKey': 'API key',
  'settings.apiKeyPlaceholder': 'Paste your API key',
  'settings.keepKey': '{masked} — leave blank to keep',
  'settings.keysHint': 'Keys stay on this machine only — never sent anywhere else.',
  'settings.model': 'Model',
  'settings.modelHint': 'Prefilled with the provider default — edit for a custom model id.',
  'settings.modelPlaceholder': 'Model id',
  'settings.test': 'Test connection',
  'settings.testing': 'Testing…',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saveFailed': 'Could not save settings.',
  'settings.testFailed': 'Connection test failed.',
  'settings.language': 'Language',
  'settings.languageHint': 'The interface language. Applies immediately.',
  'settings.router': 'Router & failover',
  'settings.routerHint': 'Add several keys per provider — Ronin rotates them and fails over when one hits a limit.',
  'settings.addKey': 'Add key',
  'settings.removeKey': 'Remove',
  'settings.keyN': 'Key {n}',
  'settings.failover': 'Automatic failover',
  'settings.failoverOrder': 'Failover order',
  'settings.requests': '{count} requests',
  'settings.cooling': 'cooling down',
  'settings.safety': 'Safety',
  'settings.envAccess': 'Allow access to .env files in this project',
  'settings.envHint': '.env files usually hold secrets. Ronin blocks them unless you allow it here.',
  'settings.projectMode': 'This project’s mode',
  'settings.modeDefault': 'Use global toggles',
  'settings.modeAuto': 'Auto — never ask',
  'settings.modePlan': 'Plan — always plan first',
  'settings.budget': 'Budget cap (USD)',
  'settings.budgetHint': 'Session spending cap. Leave empty for no cap. At the cap, new turns pause.',
  'settings.budgetPlaceholder': 'No cap',
  'settings.rtkSaved': 'Output compression saved ~{chars} characters of context so far.',

  'onboarding.welcomeTitle': 'Welcome to Ronin Code',
  'onboarding.welcomeSub': 'A calm studio for building software by describing it. Your code and keys stay on your machine.',
  'onboarding.chooseLang': 'Choose your language',
  'onboarding.continue': 'Continue',
  'onboarding.back': 'Back',
  'onboarding.providerTitle': 'Connect a provider',
  'onboarding.providerSub': 'Bring your own API key (BYOK). You can also skip this and explore in Preview mode.',
  'onboarding.skip': 'Skip for now — explore Preview mode',
  'onboarding.doneTitle': 'You are ready',
  'onboarding.doneSub': 'Create a starter project or open one of yours, then describe what to build.',
  'onboarding.startBuilding': 'Start building',
  'onboarding.testOk': 'Connection works.',

  'starters.title': 'Start from a template',
  'starters.classic': 'Classic Starter',

  'errors.no_project': 'No project is open. Open or create a project first.',
  'errors.prompt_required': 'Write a prompt first.',
  'errors.turn_running': 'A turn is already running.',
  'errors.budget_exceeded': 'Your budget cap has been reached. Raise it in Settings to keep going.',
  'errors.no_snapshot': 'No snapshot is available yet. Run a turn first, then undo becomes available.',
  'errors.not_found': 'That item no longer exists.',
  'errors.unknown': 'Something went wrong. Please try again.',
} as const;

export type StringKey = keyof typeof en;

const fa: Record<StringKey, string> = {
  'app.tagline': 'با کلمات ساده توضیح بده چی می‌خوای؛ رونین کد می‌سازدش و تو زنده تماشا می‌کنی که همین‌جا ظاهر می‌شه.',
  'app.whatBuild': 'چی می‌خوای بسازی؟',
  'app.openProject': 'باز کردن پروژه',
  'app.createStarter': 'ساخت پروژه‌ی شروع',
  'app.noProjectYet': 'هنوز پروژه‌ای نیست',
  'app.settings': 'تنظیمات',
  'app.live': 'زنده',
  'app.previewMode': 'حالت پیش‌نمایش',
  'app.previewNote': 'حالت پیش‌نمایش — برای فعال شدن، توی تنظیمات کلید API اضافه کن.',
  'app.previewHeroNote': 'حالت پیش‌نمایش — برای فعال شدن، توی تنظیمات کلید API اضافه کن.',
  'app.composerPlaceholder': 'توضیح بده چی ساخته بشه…',
  'app.composerHint': 'اینتر برای ارسال · شیفت + اینتر برای خط جدید',
  'app.send': 'ارسال',
  'app.dismiss': 'بستن',
  'app.undoFailed': 'برگرداندن انجام نشد.',
  'app.openProjectPrompt': 'مسیر پوشه‌ی پروژه',
  'app.openProjectFailed': 'اون پروژه باز نشد.',
  'app.starterFailed': 'پروژه‌ی شروع ساخته نشد.',
  'app.turnStartFailed': 'این نوبت شروع نشد.',
  'app.genericTurnError': 'توی این نوبت مشکلی پیش اومد.',
  'app.previewWillAppear': 'ساخته‌ات اینجا ظاهر می‌شه',
  'app.previewEmptySub': 'یه پروژه باز کن یا پروژه‌ی شروع بساز — همین‌جا زنده نمایش داده می‌شه.',
  'app.refreshPreview': 'تازه‌سازی پیش‌نمایش',
  'app.collapsePreview': 'بستن پیش‌نمایش',
  'app.showPreview': 'نمایش پیش‌نمایش',
  'app.auto': 'خودکار',
  'app.autoOn': 'حالت خودکار روشنه — همه‌چیز بدون سؤال اجرا می‌شه',
  'app.autoOff': 'حالت خودکار خاموشه — رونین قبل از دستورها و تغییرات بیرونی می‌پرسه',
  'app.plan': 'برنامه',
  'app.planOn': 'حالت برنامه روشنه — قبل از ساخت، برنامه رو تأیید می‌کنی',
  'app.planOff': 'حالت برنامه',
  'app.idea': 'ایده',
  'app.publish': 'انتشار',
  'app.checkpoints': 'نقاط بازگشت',
  'app.example1': 'یه بخش هیرو تیره با فرم ثبت‌نام اضافه کن',
  'app.example2': 'چیدمان رو واکنش‌گرا کن',
  'app.example3': 'یه بخش اپ تودو کوچیک اضافه کن',

  'mode.previewBadge': 'حالت پیش‌نمایش — برای فعال شدن، توی تنظیمات کلید API اضافه کن.',

  'changes.title': 'تغییرات این نوبت',
  'changes.filesChanged': '{count} فایل تغییر کرد',
  'changes.new': '{count} جدید',
  'changes.edited': '{count} ویرایش‌شده',
  'changes.undo': 'برگردان',
  'changes.undoing': 'در حال برگرداندن…',
  'changes.undone': 'برگردانده شد',
  'changes.details': 'جزئیات',
  'changes.diff': 'تفاوت',
  'changes.checkpoint': 'ذخیره نقطه‌ی بازگشت',
  'changes.checkpointName': 'اسم این نقطه‌ی بازگشت',
  'changes.largeFile': 'فایل بزرگه — تفاوت نمایش داده نمی‌شه',

  'approval.titleCommand': 'این دستور اجرا بشه؟',
  'approval.titleWrite': 'بیرون از پروژه نوشته بشه؟',
  'approval.allow': 'اجازه بده',
  'approval.deny': 'اجازه نده',
  'approval.command': 'دستور',
  'approval.path': 'مسیر',
  'approval.hint': 'برای رد شدن از این پرسش‌ها، «خودکار» رو از هدر روشن کن.',

  'plan.title': 'برنامه',
  'plan.approve': 'تأیید و ساخت',
  'plan.reject': 'رد کن',
  'plan.editHint': 'تغییر می‌خوای؟ فقط توی چت جواب بده — برنامه به‌روز می‌شه.',
  'plan.building': 'در حال ساختن برنامه‌ات…',

  'idea.title': 'از یه ایده شروع کن',
  'idea.subtitle': 'یه خط کافیه. رونین ایده رو به محصول شکل می‌ده — مخاطب، امکانات و برنامه‌ی ساخت.',
  'idea.placeholder': 'مثلاً یه اپ نوبت‌دهی برای آرایشگاه‌های شهرم…',
  'idea.mature': 'ایده‌م رو شکل بده',
  'idea.thinking': 'در حال شکل دادن…',
  'idea.audience': 'برای کیه',
  'idea.pain': 'مشکلشون',
  'idea.features': 'چی داره',
  'idea.plan': 'برنامه‌ی ساخت',
  'idea.buildIt': 'بسازش',
  'idea.again': 'از اول',
  'idea.previewNote': 'حالت پیش‌نمایش — برای ساخت واقعی، کلید یه ارائه‌دهنده رو وصل کن.',

  'publish.title': 'انتشار پروژه‌ات',
  'publish.zip': 'دانلود پروژه (zip.)',
  'publish.dist': 'خروجی نسخه‌ی ایستا (dist/)',
  'publish.distDone': 'نسخه‌ی ایستا توی dist/ ساخته شد — {count} فایل.',
  'publish.nextTitle': 'قدم بعدی چیه',
  'publish.step1': 'یه هاست انتخاب کن: هر هاست ایستایی می‌شه (سرور خودت، Netlify، Vercel، GitHub Pages…).',
  'publish.step2': 'محتوای پوشه‌ی dist/ رو اونجا آپلود کن (یا فایل دانلودی رو اونجا باز کن).',
  'publish.step3': 'از هر ثبت‌کننده‌ای یه دامنه بخر و DNS رو به هاستت وصل کن.',
  'publish.step4': 'HTTPS رو توی پنل هاست روشن کن — معمولاً یه کلیکه و با Let’s Encrypt رایگانه.',
  'publish.step5': 'لینک رو به اشتراک بذار. سایتت زنده‌ست.',

  'checkpoints.title': 'نقاط بازگشت',
  'checkpoints.empty': 'هنوز نقطه‌ی بازگشتی نیست. قبل از یه تغییر بزرگ، یکی ذخیره کن.',
  'checkpoints.save': 'ذخیره نقطه‌ی بازگشت',
  'checkpoints.restore': 'بازگردانی',
  'checkpoints.restored': '«{name}» بازگردانی شد.',
  'checkpoints.namePlaceholder': 'مثلاً قبل از بازطراحی',

  'cost.session': 'این نشست',
  'cost.thisTurn': 'این نوبت',
  'cost.est': 'تخمینی',
  'cost.budgetWarn': 'داری به سقف بودجه‌ات نزدیک می‌شی.',
  'cost.budgetHit': 'سقف بودجه پر شد — نوبت‌ها متوقفن. از تنظیمات بیشترش کن.',

  'settings.title': 'تنظیمات',
  'settings.close': 'بستن تنظیمات',
  'settings.provider': 'ارائه‌دهنده',
  'settings.noProviders': 'ارائه‌دهنده‌ای در دسترس نیست',
  'settings.endpointUrl': 'آدرس اندپوینت',
  'settings.endpointHint': 'هر اندپوینت سازگار با OpenAI — رونین مستقیم باهاش حرف می‌زنه.',
  'settings.apiKey': 'کلید API',
  'settings.apiKeyPlaceholder': 'کلید API رو بچسبون',
  'settings.keepKey': '{masked} — خالی بذار تا بمونه',
  'settings.keysHint': 'کلیدها فقط روی همین دستگاه می‌مونن — هیچ‌جا فرستاده نمی‌شن.',
  'settings.model': 'مدل',
  'settings.modelHint': 'با پیش‌فرض ارائه‌دهنده پر شده — برای مدل سفارشی ویرایشش کن.',
  'settings.modelPlaceholder': 'شناسه‌ی مدل',
  'settings.test': 'تست اتصال',
  'settings.testing': 'در حال تست…',
  'settings.save': 'ذخیره',
  'settings.saving': 'در حال ذخیره…',
  'settings.saveFailed': 'تنظیمات ذخیره نشد.',
  'settings.testFailed': 'تست اتصال ناموفق بود.',
  'settings.language': 'زبان',
  'settings.languageHint': 'زبان رابط کاربری. بلافاصله اعمال می‌شه.',
  'settings.router': 'مسیریاب و جایگزینی خودکار',
  'settings.routerHint': 'برای هر ارائه‌دهنده چند کلید اضافه کن — رونین بین‌شون می‌چرخه و وقتی یکی به سقف خورد، خودکار عوضش می‌کنه.',
  'settings.addKey': 'افزودن کلید',
  'settings.removeKey': 'حذف',
  'settings.keyN': 'کلید {n}',
  'settings.failover': 'جایگزینی خودکار',
  'settings.failoverOrder': 'ترتیب جایگزینی',
  'settings.requests': '{count} درخواست',
  'settings.cooling': 'در حال خنک شدن',
  'settings.safety': 'امنیت',
  'settings.envAccess': 'اجازه‌ی دسترسی به فایل‌های .env توی این پروژه',
  'settings.envHint': 'فایل‌های .env معمولاً رازها رو نگه می‌دارن. رونین جلوشون رو می‌گیره مگر اینجا اجازه بدی.',
  'settings.projectMode': 'حالت این پروژه',
  'settings.modeDefault': 'استفاده از سوییچ‌های کلی',
  'settings.modeAuto': 'خودکار — هیچ‌وقت نپرس',
  'settings.modePlan': 'برنامه — همیشه اول برنامه بریز',
  'settings.budget': 'سقف بودجه (دلار)',
  'settings.budgetHint': 'سقف هزینه‌ی نشست. خالی یعنی بدون سقف. با پر شدن سقف، نوبت‌های جدید متوقف می‌شن.',
  'settings.budgetPlaceholder': 'بدون سقف',
  'settings.rtkSaved': 'فشرده‌سازی خروجی تا حالا حدود {chars} نویسه از کانتکست رو ذخیره کرده.',

  'onboarding.welcomeTitle': 'به رونین کد خوش اومدی',
  'onboarding.welcomeSub': 'یه استودیوی آروم برای ساختن نرم‌افزار با توصیف کردن. کدت و کلیدهات روی دستگاه خودت می‌مونن.',
  'onboarding.chooseLang': 'زبانت رو انتخاب کن',
  'onboarding.continue': 'ادامه',
  'onboarding.back': 'برگرد',
  'onboarding.providerTitle': 'یه ارائه‌دهنده وصل کن',
  'onboarding.providerSub': 'کلید API خودت رو بیار (BYOK). می‌تونی ردش کنی و توی حالت پیش‌نمایش بچرخی.',
  'onboarding.skip': 'فعلاً رد کن — حالت پیش‌نمایش رو ببین',
  'onboarding.doneTitle': 'آماده‌ای',
  'onboarding.doneSub': 'یه پروژه‌ی شروع بساز یا پروژه‌ی خودت رو باز کن، بعد توضیح بده چی می‌خوای بسازی.',
  'onboarding.startBuilding': 'شروع ساخت',
  'onboarding.testOk': 'اتصال درسته.',

  'starters.title': 'شروع از یه قالب',
  'starters.classic': 'شروع کلاسیک',

  'errors.no_project': 'پروژه‌ای باز نیست. اول یه پروژه باز کن یا بساز.',
  'errors.prompt_required': 'اول یه متن بنویس.',
  'errors.turn_running': 'یه نوبت همین حالا در حال اجراست.',
  'errors.budget_exceeded': 'سقف بودجه‌ات پر شده. از تنظیمات بیشترش کن تا ادامه بدی.',
  'errors.no_snapshot': 'هنوز اسنپ‌شاتی نیست. اول یه نوبت اجرا کن، بعد برگردان فعال می‌شه.',
  'errors.not_found': 'اون مورد دیگه وجود نداره.',
  'errors.unknown': 'مشکلی پیش اومد. دوباره تلاش کن.',
};

const STRINGS: Record<Lang, Record<StringKey, string>> = { en, fa };

/** Host error codes → dictionary keys (host messages stay English as fallback). */
export const ERROR_CODE_KEYS: Record<string, StringKey> = {
  no_project: 'errors.no_project',
  prompt_required: 'errors.prompt_required',
  turn_running: 'errors.turn_running',
  budget_exceeded: 'errors.budget_exceeded',
  no_snapshot: 'errors.no_snapshot',
  not_found: 'errors.not_found',
};

export interface LangCtx {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  fmtNum: (n: number) => string;
  fmtUsd: (n: number) => string;
}

const Ctx = createContext<LangCtx>({
  lang: 'en',
  dir: 'ltr',
  t: (k) => en[k],
  fmtNum: (n) => String(n),
  fmtUsd: (n) => `$${n}`,
});

export function makeLangCtx(lang: Lang): LangCtx {
  const locale = lang === 'fa' ? 'fa-IR' : 'en-US';
  return {
    lang,
    dir: lang === 'fa' ? 'rtl' : 'ltr',
    t: (key, vars) => {
      let s = STRINGS[lang][key] ?? en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      }
      return s;
    },
    fmtNum: (n) => new Intl.NumberFormat(locale).format(n),
    fmtUsd: (n) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: n !== 0 && Math.abs(n) < 0.1 ? 4 : 2,
        maximumFractionDigits: n !== 0 && Math.abs(n) < 0.1 ? 4 : 2,
      }).format(n),
  };
}

export function LanguageProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: React.ReactNode;
}) {
  const value = useMemo(() => makeLangCtx(lang), [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}
