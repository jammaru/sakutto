export type SakuttoLocale = "ja" | "en";

/** Canonical origin for the product landing. */
export const SAKUTTO_ORIGIN = "https://sakutto.jammaru.com";

export const SAKUTTO_LINKS = {
  chrome:
    "https://chromewebstore.google.com/detail/sakutto-local-ai-translat/mhlbjjijfkoghmcjndgdimhdlfkhadfl",
  firefox:
    "https://addons.mozilla.org/ja/firefox/addon/sakutto-local-ai-translation/",
  github: "https://github.com/jammaru/sakutto",
  issues: "https://github.com/jammaru/sakutto/issues",
  changelog: "https://github.com/jammaru/sakutto/blob/main/CHANGELOG.md",
  license: "https://github.com/jammaru/sakutto/blob/main/LICENSE",
  discord: "https://discord.gg/pdSRBaSr38",
  sponsors: "https://github.com/sponsors/jammaru",
  x: "https://x.com/jammaru_lab",
  privacyJa: `${SAKUTTO_ORIGIN}/privacy/`,
  privacyEn: `${SAKUTTO_ORIGIN}/en/privacy/`,
  authorProfile: "https://github.com/jammaru",
  plamo: "https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF",
  pfnForm: "https://forms.gle/mTL8tBLrMYXKNZD56",
} as const;

export const SAKUTTO_OG_IMAGES: Record<SakuttoLocale, string> = {
  ja: `${SAKUTTO_ORIGIN}/og-ja.jpg`,
  en: `${SAKUTTO_ORIGIN}/og-en.jpg`,
};

/** Firefox uses a localized store path; Chrome does not. */
export const firefoxHref = (locale: SakuttoLocale): string =>
  locale === "ja"
    ? SAKUTTO_LINKS.firefox
    : SAKUTTO_LINKS.firefox.replace("/ja/", "/en-US/");

export interface SakuttoFaqLink {
  label: string;
  href: string;
}

export interface SakuttoFaq {
  q: string;
  a: string;
  links?: readonly SakuttoFaqLink[];
}

export interface SakuttoFeature {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  bullets: readonly string[];
  image: string;
  alt: string;
  caption: string;
}

export interface SakuttoLocalStrength {
  title: string;
  body: string;
  link: { label: string; href: string };
}

export interface SakuttoLocalStrengths {
  title: string;
  lead: string;
  items: readonly SakuttoLocalStrength[];
}

export interface SakuttoCopy {
  meta: { title: string; description: string; ogAlt: string };
  nav: {
    skip: string;
    features: string;
    how: string;
    faq: string;
    download: string;
    theme: string;
    language: string;
    github: string;
  };
  hero: {
    version: string;
    eyebrow: string;
    titleLines: readonly string[];
    lead: string;
    chrome: string;
    firefox: string;
    notes: readonly string[];
    storeNote: string;
    attribution: string;
    mediaAlt: string;
  };
  stats: {
    items: readonly { value: string; label: string; note: string }[];
    aside: string;
  };
  intro: {
    eyebrow: string;
    title: string;
    lead: string;
    items: readonly { title: string; body: string }[];
  };
  localStrengths: SakuttoLocalStrengths;
  features: {
    eyebrow: string;
    title: string;
    lead: string;
    items: readonly SakuttoFeature[];
    extrasTitle: string;
    extras: readonly string[];
    summary: string;
  };
  trust: { label: string; items: readonly string[] };
  showcase: {
    eyebrow: string;
    titleMuted: string;
    titleStrong: string;
    tabs: readonly { label: string; image: string; alt: string; caption: string }[];
    note: string;
  };
  facts: {
    eyebrow: string;
    titleMuted: string;
    titleStrong: string;
    tabLabel: string;
    rows: readonly { key: string; value: string }[];
    note: string;
  };
  openSource: { eyebrow: string; title: string; lead: string; button: string };
  more: {
    eyebrow: string;
    title: string;
    lead: string;
    items: readonly { title: string; body: string; image: string; alt: string }[];
  };
  how: {
    eyebrow: string;
    title: string;
    lead: string;
    steps: readonly { title: string; body: string }[];
    note: string;
  };
  privacy: {
    eyebrow: string;
    title: string;
    lead: string;
    points: readonly string[];
    details: string;
    detailsBody: string;
    link: string;
  };
  faq: {
    eyebrow: string;
    title: string;
    lead: string;
    items: readonly SakuttoFaq[];
  };
  community: {
    eyebrow: string;
    title: string;
    lead: string;
    cards: readonly { title: string; body: string; link: string; href: string }[];
  };
  cta: {
    eyebrow: string;
    title: string;
    titleMuted: string;
    titleStrong: string;
    lead: string;
    chrome: string;
    firefox: string;
    note: string;
  };
  footer: {
    tagline: string;
    credit: string;
    license: string;
    links: readonly { label: string; href: string }[];
  };
}

const japanese: SakuttoCopy = {
  meta: {
    title: "Sakutto | ローカルAI翻訳",
    description:
      "PLaMo 3 Translate をブラウザ内で動かす、無料・MIT の Chrome / Firefox 拡張機能。ページ、スキャン PDF、画像、YouTube の字幕を端末で翻訳します。アカウント不要。",
    ogAlt: "Sakutto のロゴと「ブラウザ向けのローカル LLM 翻訳」のタグライン、Chrome 拡張機能と Firefox Add-on のバッジ",
  },
  nav: {
    skip: "本文へ",
    features: "機能",
    how: "仕組み",
    faq: "FAQ",
    download: "ダウンロード",
    theme: "テーマを切り替える",
    language: "言語",
    github: "Sakutto の GitHub",
  },
  hero: {
    version: "v1.10.0",
    eyebrow: "PLaMo 3 Translate · Chrome & Firefox",
    titleLines: ["ページも PDF も、", "端末で訳す。"],
    lead:
      "Sakutto は、PLaMo 3 Translate をブラウザの中で動かす翻訳拡張機能です。Web ページ、段組み PDF、画像、動画の字幕を、開いているタブの中で翻訳します。",
    chrome: "Chrome に追加",
    firefox: "Firefox に追加",
    notes: ["無料・MIT", "アカウント不要", "Chrome 116+ / Firefox 153+"],
    storeNote: "Chrome ウェブストアと Firefox Add-ons で公開中。",
    attribution:
      "Built with PLaMo. 非公式の拡張機能で、Preferred Networks, Inc. とは無関係です。",
    mediaAlt: "英語の記事が日本語に置き換わったページ翻訳の画面",
  },
  stats: {
    items: [
      { value: "8,000+", label: "ユーザー", note: "2026-11-24 時点" },
      { value: "303", label: "GitHub stars", note: "2026-11-25 取得" },
      { value: "53", label: "言語", note: "PLaMo 3 Translate" },
    ],
    aside: "本文は既定では翻訳サーバーへ送りません。",
  },
  intro: {
    eyebrow: "LOCAL FIRST",
    title: "翻訳は、ブラウザの中で完結する。",
    lead:
      "モデルを一度ダウンロードすれば、あとは端末の WebGPU で翻訳します。読みたいものを外に出す必要はありません。",
    items: [
      {
        title: "テキストは端末に残る",
        body: "ページ本文、選択範囲、用語集、訳文を開発者へ送りません。アカウント、広告、テレメトリはありません。",
      },
      {
        title: "段組み PDF に対応",
        body: "二段組の論文も表もレイアウトを保ったまま訳し、訳文付き PDF として保存できます。",
      },
      {
        title: "いま開いている場所で読む",
        body: "ページ、PDF、画像、字幕を、いま開いているタブで。原文と訳文を並べて確認できます。",
      },
      {
        title: "設定はサイトごとに",
        body: "翻訳先の言語や読み方をサイト単位で設定。全サイトへのアクセスはオプトインです。",
      },
    ],
  },
  localStrengths: {
    title: "翻訳は、この端末の中で。",
    lead: "翻訳エンジンも、あなたの読む内容も、このブラウザの中に。",
    items: [
      {
        title: "情報を外部に送信しない",
        body: "ページ・PDF・字幕の内容は、デフォルトで外部のサーバーに送信されません。開発者が翻訳内容を取得することもありません。",
        link: { label: "詳しく見る", href: SAKUTTO_LINKS.privacyJa },
      },
      {
        title: "ブラウザ内で翻訳が完結",
        body: "翻訳モデル「PLaMo 3 Translate」がブラウザ内で直接動作します。WebGPUまたはCPUを利用し、端末上で翻訳処理を行います。",
        link: { label: "詳しく見る", href: SAKUTTO_LINKS.github },
      },
      {
        title: "完全無料、広告も分析ツールもなし",
        body: "無料・アカウント不要。広告・分析・テレメトリなし。MIT オープンソース。",
        link: { label: "詳しく見る", href: SAKUTTO_LINKS.license },
      },
    ],
  },
  features: {
    eyebrow: "FEATURES",
    title: "読むものは、ひとつじゃない。",
    lead:
      "Web ページ、PDF、画像、字幕。同じローカルエンジンが、いま必要なものを翻訳します。",
    items: [
      {
        id: "page",
        eyebrow: "PAGE TRANSLATION",
        title: "ページを、その場で読み替える。",
        body: "Alt+A で翻訳、Alt+B で表示を切り替え。文ごとに置き換える方式と、段落を保って入れ替える方式を選べます。",
        bullets: [
          "Alt+S で選択範囲、Alt+T で入力中のテキストを翻訳",
          "Firefox では Alt+Shift+文字が既定",
          "テキストの高さを保つので読む位置がずれにくい",
        ],
        image: "/media/capture-page-translation.webp",
        alt: "英語の合成記事が日本語に置き換わったページ翻訳の画面",
        caption: "実際の拡張機能で写した、原文と訳文の入れ替え。",
      },
      {
        id: "pdf",
        eyebrow: "PDF & SCANNED PDF",
        title: "PDF は、レイアウトごと訳す。",
        body: "二段組みの論文や表の数字を、元の枠に収めたまま翻訳。テキスト層のないスキャン PDF だけ、端末内の PP-OCRv6 で文字を読み取ります。",
        bullets: [
          "訳文付き PDF をダウンロード可能",
          "OCR は標準約 23 MB、高精度版約 140 MB（任意）",
          "OCR 結果はキャッシュされ、先読みされます",
        ],
        image: "/media/capture-pdf.webp",
        alt: "二段組みの合成 PDF と、レイアウトを保った訳文",
        caption: "二段組みの PDF を、段組みのまま翻訳した画面。",
      },
      {
        id: "image",
        eyebrow: "IMAGE TRANSLATION",
        title: "画像の中の文字も、右クリックから。",
        body: "画像を右クリックして Sakutto を選ぶと、認識した原文と訳文を並べて表示します。文字起こしは PP-OCRv6 が端末内で行います。",
        bullets: [
          "その画像だけをコンテキストメニューから翻訳",
          "日本語と英語の横書き・縦書きに対応",
          "OCR モデルは初回のみ取得、以降はオフラインで動作",
        ],
        image: "/media/capture-ocr-image.webp",
        alt: "右クリックで画像内の文字を翻訳した画面",
        caption: "画像の文字を認識し、訳文を並べて表示します。",
      },
      {
        id: "captions",
        eyebrow: "VIDEO CAPTIONS",
        title: "字幕は、映像に合わせて届く。",
        body: "YouTube（ライブ含む）と X の字幕を翻訳。録画では字幕を先読みし、文ごとに映像と同期して表示します。",
        bullets: [
          "ライブでは原文と訳文の二行を表示",
          "原文を隠す、サイズ変更、ドラッグで移動が可能",
          "[Music] などの効果音タグは訳しません",
        ],
        image: "/media/capture-captions.webp",
        alt: "動画プレーヤーに原文と訳文の字幕が表示された画面",
        caption: "先読みした訳文が、映像の文と一緒に現れます。",
      },
    ],
    extrasTitle: "ほかの機能",
    extras: [
      "選択範囲の翻訳",
      "入力テキストのプレビュー",
      "サイトごとの用語集（最大 5,000 語）",
      "やさしい日本語",
      "実験的なローカルサーバー",
    ],
    summary: "ひとつのローカルエンジンで、ページも PDF も画像も字幕も。",
  },
  trust: {
    label: "PLaMo 3 Translate とともに",
    items: ["Chrome", "Firefox", "MIT License", "On-device · WebGPU", "No account", "53 languages"],
  },
  showcase: {
    eyebrow: "IN THE TAB",
    titleMuted: "いま読んでいる場所で、",
    titleStrong: "そのまま訳す。",
    tabs: [
      { label: "ページ", image: "/media/capture-page-translation.webp", alt: "ページ翻訳の画面", caption: "英語の記事を日本語に置き換えた画面。" },
      { label: "PDF", image: "/media/capture-pdf.webp", alt: "PDF 翻訳の画面", caption: "二段組みの PDF をレイアウトごと翻訳した画面。" },
      { label: "画像", image: "/media/capture-ocr-image.webp", alt: "画像翻訳の画面", caption: "画像内の文字を認識して訳した画面。" },
    ],
    note: "Alt+A で翻訳、Alt+B で原文との切り替え。",
  },
  facts: {
    eyebrow: "LOCAL BY DEFAULT",
    titleMuted: "モデルは端末で動く。",
    titleStrong: "設定は最小限。",
    tabLabel: "runtime",
    rows: [
      { key: "model", value: "PLaMo 3 Translate 0.8B" },
      { key: "runtime", value: "WebGPU / CPU fallback" },
      { key: "languages", value: "53" },
      { key: "account", value: "none" },
      { key: "license", value: "MIT" },
    ],
    note: "初回のモデル取得以外に、本文を送る通信はありません。",
  },
  openSource: {
    eyebrow: "BUILT IN THE OPEN",
    title: "開発は、オープンに。",
    lead: "Sakutto のコードは MIT ライセンス。Issue と pull request を歓迎します。",
    button: "GitHub で見る",
  },
  more: {
    eyebrow: "MORE CAPABILITIES",
    title: "細かいところまで、使える。",
    lead: "用語集、やさしい日本語、ローカルサーバー。設定はすべて拡張機能の中で完結します。",
    items: [
      {
        title: "サイトごとの用語集",
        body: "最大 5,000 語。訳に固定したい語句をサイト単位で登録できます。",
        image: "/media/capture-settings-glossary.webp",
        alt: "Sakutto の用語集設定画面",
      },
      {
        title: "やさしい日本語",
        body: "訳先としてやさしい日本語を選択できます。",
        image: "/media/capture-settings-easy-japanese.webp",
        alt: "やさしい日本語を訳先に選んだ設定画面",
      },
      {
        title: "ローカルサーバー（実験的）",
        body: "OpenAI 互換のローカルサーバーを、設定したときだけ使えます。",
        image: "/media/capture-settings-engine.webp",
        alt: "ローカルサーバーを設定する画面",
      },
    ],
  },
  how: {
    eyebrow: "HOW IT WORKS",
    title: "入れて、待って、読む。",
    lead: "設定は最小限。一度の準備で、翻訳はこの端末の中で動きます。",
    steps: [
      {
        title: "拡張機能を追加する",
        body: "Chrome ウェブストア、または Firefox Add-ons からインストールします。",
      },
      {
        title: "モデルを一度ダウンロードする",
        body: "PLaMo 0.8B（約 546 MB）と OCR（約 23 MB）を取得。SHA-256 で検証し、中断しても続きから再開できます。",
      },
      {
        title: "いつものページで翻訳する",
        body: "Web ページ、PDF、画像、字幕を、端末上の PLaMo が翻訳します。",
      },
    ],
    note: "モデルの重みはリポジトリにも拡張パッケージにも含まれていません。",
  },
  privacy: {
    eyebrow: "PRIVACY",
    title: "読んだものは、外に出さない。",
    lead: "内蔵エンジンはブラウザの中で動きます。アカウントも広告もテレメトリもありません。",
    points: [
      "ページ本文、選択範囲、用語集、訳文を開発者へ送りません",
      "通信はモデルの初回取得と、PDF を表示中のサイトからファイルを取得するときだけ",
      "サイトへのアクセスは必要なときだけ要求し、いつでも取り消せます",
    ],
    details: "自分でサーバーを指定した場合は？",
    detailsBody:
      "OpenAI 互換のローカルサーバーは実験的な設定です。有効にしたときだけ、指定したアドレスへ文章を送ります。既定ではありません。",
    link: "プライバシーポリシーを見る",
  },
  faq: {
    eyebrow: "FAQ",
    title: "よくある質問",
    lead: "ブラウザ、モデル、プライバシーについて。",
    items: [
      {
        q: "GPU がなくても使えますか？",
        a: "使えます。WebGPU が使える環境では GPU を、使えないときは CPU を使います。設定で切り替え可能です。Firefox の CPU 翻訳はシングルスレッドです。",
      },
      {
        q: "モデルのサイズは？",
        a: "PLaMo 0.8B（Q4_K_M）は約 546 MB です。OCR は標準約 23 MB、高精度版約 140 MB（任意）。初回のみ取得し、SHA-256 で検証して端末に保存します。",
      },
      {
        q: "対応ブラウザは？",
        a: "Chrome 116 以降と、デスクトップの Firefox 153 以降（Windows、macOS、Linux）。Firefox for Android には対応していません。",
      },
      {
        q: "オフラインで使えますか？",
        a: "モデルをダウンロードした後、翻訳のために本文を外部へ送る必要はありません。初回取得にはネットワークが必要です。",
      },
      {
        q: "翻訳はどこへ送られますか？",
        a: "既定では、ページ本文、選択範囲、用語集、訳文を開発者へ送りません。アカウント、広告、テレメトリもありません。",
        links: [{ label: "プライバシーポリシー", href: SAKUTTO_LINKS.privacyJa }],
      },
      {
        q: "スキャン PDF は翻訳できますか？",
        a: "できます。テキスト層のないページだけ PP-OCRv6 が端末内で文字を読み取り、翻訳します。結果は PDF として保存できます。",
      },
      {
        q: "対応言語は？",
        a: "PLaMo 3 Translate は 53 言語の双方向翻訳に対応します。Chrome では PLaMo が対応しない一部の言語に内蔵翻訳を使います。UI は 14 言語です。",
      },
      {
        q: "料金はかかりますか？",
        a: "無料です。MIT ライセンスのオープンソースで、広告も有料機能もありません。GitHub Sponsors は任意です。",
        links: [{ label: "GitHub Sponsors", href: SAKUTTO_LINKS.sponsors }],
      },
      {
        q: "商用利用できますか？",
        a: "Sakutto のコードは MIT ライセンスです。PLaMo 3 Translate のモデルは PLaMo Community License で、個人・学術利用は登録不要。商業利用には PFN への事前登録と売上条件があります。",
        links: [
          { label: "PLaMo 3 Translate", href: SAKUTTO_LINKS.plamo },
          { label: "登録フォーム", href: SAKUTTO_LINKS.pfnForm },
        ],
      },
      {
        q: "サイトごとに設定できますか？",
        a: "できます。訳先の言語、表示、自動翻訳、用語集をサイト単位で設定。ホスト権限は自動翻訳を有効にしたときだけ要求します。",
      },
    ],
  },
  community: {
    eyebrow: "OPEN SOURCE",
    title: "開発は、オープンに。",
    lead: "Issue と pull request を歓迎します。",
    cards: [
      {
        title: "GitHub",
        body: "ソースコード、Issue、リリースノート。",
        link: "リポジトリを見る",
        href: SAKUTTO_LINKS.github,
      },
      {
        title: "Discord",
        body: "使い方の質問や開発の相談。",
        link: "参加する",
        href: SAKUTTO_LINKS.discord,
      },
      {
        title: "Changelog",
        body: "リリースごとの変更点。",
        link: "更新履歴",
        href: SAKUTTO_LINKS.changelog,
      },
    ],
  },
  cta: {
    eyebrow: "GET STARTED",
    title: "いつものページで、訳す。",
    titleMuted: "いつものページで、",
    titleStrong: "訳す。",
    lead: "拡張機能を追加して、モデルを一度ダウンロード。あとは読むだけです。",
    chrome: "Chrome に追加",
    firefox: "Firefox に追加",
    note: "無料・MIT ライセンス・アカウント不要",
  },
  footer: {
    tagline: "端末の中で動く、オープンソースの翻訳拡張機能。",
    credit: "by jammaru",
    license: "MIT License",
    links: [
      { label: "Chrome", href: SAKUTTO_LINKS.chrome },
      { label: "Firefox", href: firefoxHref("ja") },
      { label: "GitHub", href: SAKUTTO_LINKS.github },
      { label: "Changelog", href: SAKUTTO_LINKS.changelog },
      { label: "Privacy", href: SAKUTTO_LINKS.privacyJa },
    ],
  },
};

const english: SakuttoCopy = {
  meta: {
    title: "Sakutto | Translate pages and PDFs on your device",
    description:
      "A free, MIT-licensed Chrome and Firefox extension running PLaMo 3 Translate in your browser. Translate pages, scanned PDFs, images, and YouTube captions on device. No account required.",
    ogAlt: "Sakutto logo, the tagline 'A local LLM translator for your browser.', and Chrome Extension and Firefox Add-on badges",
  },
  nav: {
    skip: "Skip to content",
    features: "Features",
    how: "How it works",
    faq: "FAQ",
    download: "Download",
    theme: "Toggle theme",
    language: "Language",
    github: "Sakutto on GitHub",
  },
  hero: {
    version: "v1.10.0",
    eyebrow: "PLaMo 3 Translate · Chrome & Firefox",
    titleLines: ["Translate pages", "and PDFs locally."],
    lead:
      "Sakutto runs PLaMo 3 Translate inside your browser. Web pages, two-column PDFs, images, and video captions — translated in the tab you already have open.",
    chrome: "Add to Chrome",
    firefox: "Add to Firefox",
    notes: ["Free · MIT", "No account", "Chrome 116+ / Firefox 153+"],
    storeNote: "Available in the Chrome Web Store and Firefox Add-ons.",
    attribution:
      "Built with PLaMo. Unofficial extension, not affiliated with Preferred Networks, Inc.",
    mediaAlt: "An English article swapped to Japanese by page translation",
  },
  stats: {
    items: [
      { value: "8,000+", label: "users", note: "as of 2026-11-24" },
      { value: "303", label: "GitHub stars", note: "fetched 2026-11-25" },
      { value: "53", label: "languages", note: "PLaMo 3 Translate" },
    ],
    aside: "Page text is not sent to a translation server by default.",
  },
  intro: {
    eyebrow: "LOCAL FIRST",
    title: "Translation stays in the browser.",
    lead:
      "Download the model once. After that, WebGPU on your device does the work. What you read does not need to leave the machine.",
    items: [
      {
        title: "Text stays put",
        body: "Page text, selections, glossaries, and translations are not sent to the developer. No account, no ads, no telemetry.",
      },
      {
        title: "Layout-aware PDFs",
        body: "Two-column papers and tables keep their structure, and you can save the translated result as a PDF.",
      },
      {
        title: "Read in place",
        body: "Pages, PDFs, images, and captions are translated in the open tab. Compare the original with the translation.",
      },
      {
        title: "Per-site control",
        body: "Set the target language and reading style per site. Access to all sites is opt-in and can be revoked.",
      },
    ],
  },
  localStrengths: {
    title: "Translation stays on this device.",
    lead: "The engine runs in your browser, and the text you read stays there by default.",
    items: [
      {
        title: "Nothing is sent outside",
        body: "Page, PDF, and caption content is not sent to external servers by default. The developer never receives what you translate.",
        link: { label: "Learn more", href: SAKUTTO_LINKS.privacyEn },
      },
      {
        title: "Translation runs in the browser",
        body: "The PLaMo 3 Translate model runs directly in your browser, using WebGPU or CPU to do the translation on your device.",
        link: { label: "Learn more", href: SAKUTTO_LINKS.github },
      },
      {
        title: "Free, no ads or analytics",
        body: "Free, no account, no ads, no analytics/telemetry; MIT open source.",
        link: { label: "Learn more", href: SAKUTTO_LINKS.license },
      },
    ],
  },
  features: {
    eyebrow: "FEATURES",
    title: "More than one kind of page.",
    lead:
      "Web pages, PDFs, images, captions. The same local engine handles whatever you are reading.",
    items: [
      {
        id: "page",
        eyebrow: "PAGE TRANSLATION",
        title: "Translate the page in place.",
        body: "Alt+A translates, Alt+B switches the view. Choose sentence-by-sentence replacement or a single short swap that preserves paragraph height.",
        bullets: [
          "Alt+S translates a selection; Alt+T translates typed text",
          "Firefox uses Alt+Shift+letter shortcuts",
          "Block height is preserved so your place stays put",
        ],
        image: "/media/capture-page-translation.webp",
        alt: "A synthetic English article swapped to Japanese on the page",
        caption: "The in-place text swap, captured from the real extension.",
      },
      {
        id: "pdf",
        eyebrow: "PDF & SCANNED PDF",
        title: "PDFs keep their columns.",
        body: "Translations are fitted into the space the source text occupied, so two-column papers and table numbers stay in place. Image-only pages are read with on-device PP-OCRv6.",
        bullets: [
          "Download the translated PDF",
          "Standard OCR is about 23 MB; high accuracy about 140 MB (optional)",
          "OCR results are cached and prefetched",
        ],
        image: "/media/capture-pdf.webp",
        alt: "A synthetic two-column PDF with its layout preserved in Japanese",
        caption: "A two-column PDF translated without losing its layout.",
      },
      {
        id: "image",
        eyebrow: "IMAGE TRANSLATION",
        title: "Text in an image, one right-click away.",
        body: "Right-click an image and choose Sakutto to see the recognized source text next to its translation. PP-OCRv6 reads horizontal and vertical Japanese and English on your device.",
        bullets: [
          "Translate a single image from the context menu",
          "Compare recognized text with the translation",
          "Download OCR once; recognition works offline afterwards",
        ],
        image: "/media/capture-ocr-image.webp",
        alt: "Image text translated from the right-click menu",
        caption: "Recognized image text shown next to its translation.",
      },
      {
        id: "captions",
        eyebrow: "VIDEO CAPTIONS",
        title: "Captions that keep up with the video.",
        body: "Translate captions on YouTube (including live streams) and X. On recorded video, Sakutto prefetches the caption track and shows each sentence in sync.",
        bullets: [
          "Live streams show original and translation in two lines",
          "Hide the original, resize, or drag the overlay",
          "Sound tags such as [Music] are left alone",
        ],
        image: "/media/capture-captions.webp",
        alt: "Video player showing original and translated captions together",
        caption: "Prefetched translations appear with their sentence.",
      },
    ],
    extrasTitle: "Also included",
    extras: [
      "selection translation",
      "a preview for typed text",
      "per-site glossaries (up to 5,000 terms)",
      "Easy Japanese as a target",
      "an experimental local server",
    ],
    summary: "One local engine for pages, PDFs, images, and captions.",
  },
  trust: {
    label: "Built with PLaMo 3 Translate",
    items: ["Chrome", "Firefox", "MIT License", "On-device · WebGPU", "No account", "53 languages"],
  },
  showcase: {
    eyebrow: "IN THE TAB",
    titleMuted: "Translate it where you read,",
    titleStrong: "without leaving the tab.",
    tabs: [
      { label: "Page", image: "/media/capture-page-translation.webp", alt: "Page translation screenshot", caption: "An English article swapped to Japanese on the page." },
      { label: "PDF", image: "/media/capture-pdf.webp", alt: "PDF translation screenshot", caption: "A two-column PDF translated with its layout intact." },
      { label: "Image", image: "/media/capture-ocr-image.webp", alt: "Image translation screenshot", caption: "Recognized image text shown next to its translation." },
    ],
    note: "Alt+A translates. Alt+B switches back to the original.",
  },
  facts: {
    eyebrow: "LOCAL BY DEFAULT",
    titleMuted: "The model runs on your device.",
    titleStrong: "Almost nothing to configure.",
    tabLabel: "runtime",
    rows: [
      { key: "model", value: "PLaMo 3 Translate 0.8B" },
      { key: "runtime", value: "WebGPU / CPU fallback" },
      { key: "languages", value: "53" },
      { key: "account", value: "none" },
      { key: "license", value: "MIT" },
    ],
    note: "No request sends page text out for translation by default.",
  },
  openSource: {
    eyebrow: "BUILT IN THE OPEN",
    title: "Built in the open.",
    lead: "Sakutto is MIT licensed. Issues and pull requests are welcome.",
    button: "View on GitHub",
  },
  more: {
    eyebrow: "MORE CAPABILITIES",
    title: "The details are there too.",
    lead: "Glossaries, Easy Japanese, and a local server — all configured inside the extension.",
    items: [
      {
        title: "Per-site glossaries",
        body: "Up to 5,000 terms to keep your wording consistent, set per site.",
        image: "/media/capture-settings-glossary.webp",
        alt: "The Sakutto glossary settings screen",
      },
      {
        title: "Easy Japanese",
        body: "A simplified Japanese target for readers who need it.",
        image: "/media/capture-settings-easy-japanese.webp",
        alt: "Settings screen with Easy Japanese selected as the target",
      },
      {
        title: "Local server (experimental)",
        body: "An OpenAI-compatible local server, used only when you enable it.",
        image: "/media/capture-settings-engine.webp",
        alt: "The local server settings screen",
      },
    ],
  },
  how: {
    eyebrow: "HOW IT WORKS",
    title: "Add it. Wait. Read.",
    lead: "No complicated setup. Once the models are ready, translation runs on this device.",
    steps: [
      {
        title: "Add the extension",
        body: "Install Sakutto from the Chrome Web Store or Firefox Add-ons.",
      },
      {
        title: "Download the models once",
        body: "PLaMo 0.8B (about 546 MB) and OCR (about 23 MB). Digests are checked against SHA-256 and interrupted downloads resume.",
      },
      {
        title: "Translate where you read",
        body: "Pages, PDFs, images, and captions are translated by PLaMo on this device.",
      },
    ],
    note: "Model weights are neither in the repository nor in the extension package.",
  },
  privacy: {
    eyebrow: "PRIVACY",
    title: "What you read stays here.",
    lead: "The built-in engine runs inside your browser. No account, no ads, no telemetry.",
    points: [
      "Page text, selections, glossaries, and translations are not sent to the developer",
      "Requests are limited to the model download and, for a PDF, the file from the tab's own site",
      "Site access is requested only when needed and can be revoked at any time",
    ],
    details: "What if I point Sakutto at my own server?",
    detailsBody:
      "The local OpenAI-compatible server is experimental. Text is sent only to the address you set, and only when you enable it. It is not the default.",
    link: "Read the privacy policy",
  },
  faq: {
    eyebrow: "FAQ",
    title: "Frequently asked questions",
    lead: "Browsers, models, and privacy — the short answers.",
    items: [
      {
        q: "Can I use it without a GPU?",
        a: "Yes. Sakutto uses WebGPU when available and falls back to the CPU otherwise. You can switch in Settings. On Firefox, CPU translation uses one thread.",
      },
      {
        q: "How large are the models?",
        a: "PLaMo 0.8B (Q4_K_M) is about 546 MB. OCR is about 23 MB standard or about 140 MB high accuracy (optional). Models are downloaded once, verified against SHA-256 digests, and kept on the device.",
      },
      {
        q: "Which browsers are supported?",
        a: "Chrome 116 or later and desktop Firefox 153 or later (Windows, macOS, and Linux). Firefox for Android is not supported.",
      },
      {
        q: "Does it work offline?",
        a: "After the models are downloaded, page text is not sent out for translation. The first download needs a network connection.",
      },
      {
        q: "Where does my text go?",
        a: "By default, page text, selections, glossaries, and translations are not sent to the developer. There is no account, ads, or telemetry.",
        links: [{ label: "Privacy policy", href: SAKUTTO_LINKS.privacyEn }],
      },
      {
        q: "Can it translate scanned PDFs?",
        a: "Yes. On pages without a text layer, PP-OCRv6 recognizes the text on your device and Sakutto translates it. The result can be saved as a PDF.",
      },
      {
        q: "Which languages are supported?",
        a: "PLaMo 3 Translate supports 53 languages in either direction. On Chrome, a small set of unsupported languages uses the built-in translator. The interface is available in 14 languages.",
      },
      {
        q: "Is it really free?",
        a: "Yes. Sakutto is MIT-licensed open source, with no ads and no paid features. GitHub Sponsors is optional.",
        links: [{ label: "GitHub Sponsors", href: SAKUTTO_LINKS.sponsors }],
      },
      {
        q: "Can I use it commercially?",
        a: "Sakutto's code is MIT-licensed. The PLaMo 3 Translate model uses the PLaMo Community License: personal and academic use need no registration. Commercial use requires prior registration with PFN and a revenue limit.",
        links: [
          { label: "PLaMo 3 Translate", href: SAKUTTO_LINKS.plamo },
          { label: "Registration form", href: SAKUTTO_LINKS.pfnForm },
        ],
      },
      {
        q: "Can I configure sites individually?",
        a: "Yes. Each site can have its own target language, reading style, automatic translation setting, and glossary. Host access is requested only when you enable automatic translation.",
      },
    ],
  },
  community: {
    eyebrow: "OPEN SOURCE",
    title: "Built in the open.",
    lead: "Issues and pull requests are welcome.",
    cards: [
      {
        title: "GitHub",
        body: "Source code, issues, and release notes.",
        link: "View the repository",
        href: SAKUTTO_LINKS.github,
      },
      {
        title: "Discord",
        body: "Questions about using Sakutto or contributing.",
        link: "Join Discord",
        href: SAKUTTO_LINKS.discord,
      },
      {
        title: "Changelog",
        body: "What changed in each release.",
        link: "Release notes",
        href: SAKUTTO_LINKS.changelog,
      },
    ],
  },
  cta: {
    eyebrow: "GET STARTED",
    title: "Translate it where you read it.",
    titleMuted: "Translate it where you read it.",
    titleStrong: "Start today.",
    lead: "Add the extension, download the models once, and get back to reading.",
    chrome: "Add to Chrome",
    firefox: "Add to Firefox",
    note: "Free · MIT licensed · No account",
  },
  footer: {
    tagline: "Open-source translation that runs on your device.",
    credit: "by jammaru",
    license: "MIT License",
    links: [
      { label: "Chrome", href: SAKUTTO_LINKS.chrome },
      { label: "Firefox", href: firefoxHref("en") },
      { label: "GitHub", href: SAKUTTO_LINKS.github },
      { label: "Changelog", href: SAKUTTO_LINKS.changelog },
      { label: "Privacy", href: SAKUTTO_LINKS.privacyEn },
    ],
  },
};

export const sakuttoCopy: Record<SakuttoLocale, SakuttoCopy> = {
  ja: japanese,
  en: english,
};
