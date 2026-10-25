// Instruction-override lexicons for languages the hand-written regexes in
// heuristic.ts do not cover.
//
// Why a lexicon and not more anchors: the embedding stage aligns a translated
// "ignore all previous instructions" to the English anchors at only 0.80-0.86,
// under the 0.86 block line, and no threshold separates those attacks from
// benign text in the same language (measured over 132 playground languages:
// sim >= 0.84 catches 66% of attacks but blocks 3.6% of benign prompts).
// Same-language anchors were worse: e5 scores any sentence near an anchor in
// its own language, and 76% of benign prompts blocked.
//
// A match is the shape every override shares, in any language: an override
// verb whose object is an instruction noun qualified by a positional
// ("previous", "above", "earlier"). The object must sit within `window`
// tokens after the verb (VO languages) or before it (OV languages), and the
// window ends at a clause break or a breaker word ("and", "follow", "not"),
// so "skip this step and follow the previous instructions" and "don't forget
// the earlier rules" do not match. Every stem is passed through normalize()
// at load, so it is compared in the same form the scorer sees (diacritics and
// Indic/Thai vowel signs stripped, lowercase).
//
// A word ending in `*` is a stem (prefix match); otherwise the token must
// match exactly. Multi-word entries match consecutive tokens.

import { normalize } from './normalize.js'

interface Lexicon {
  order: Order
  verbs: string[]
  positionals: string[]
  nouns: string[]
  /** Tokens that end the object window ("and", "follow", "not"). */
  breakers?: string[]
  /** A token directly before the verb that cancels it ("do not forget"). */
  notBefore?: string[]
  /** Tokens the object may span; default 6. */
  window?: number
  /** Script without word spaces: match substrings, window in characters. */
  unspaced?: boolean
}

export const OVERRIDE_LEXICONS: Record<string, Lexicon> = {
  // Indo-Aryan and Dravidian: object before the verb.
  hi: {
    order: 'OV',
    verbs: ['अनदेखा*', 'नज़रअंदाज़*', 'नजरअंदाज*', 'ध्यान न दे*', 'ध्यान मत दे*', 'भूल जा*', 'उपेक्षा*'],
    positionals: ['पिछल*', 'पूर्व', 'पहले', 'ऊपर', 'उपरोक्त', 'पुरान*'],
    nouns: ['निर्देश*', 'नियम*', 'आदेश*', 'हिदायत*', 'दिशानिर्देश*'],
    breakers: ['और', 'तथा', 'पालन'],
  },
  mr: {
    order: 'OV',
    verbs: ['दुर्लक्ष*', 'विसर*'],
    positionals: ['मागील', 'पूर्व', 'आधी*', 'पूर्वीच*', 'वरील'],
    nouns: ['सूचना*', 'निर्देश*', 'नियम*', 'आज्ञा*'],
    breakers: ['आणि', 'पालन'],
  },
  ne: {
    order: 'OV',
    verbs: ['बेवास्ता*', 'बिर्स*', 'उपेक्षा*'],
    positionals: ['अघिल्ल*', 'पूर्व', 'पहिले*', 'माथिक*'],
    nouns: ['निर्देशन*', 'निर्देश*', 'नियम*', 'आदेश*'],
    breakers: ['र', 'पालना'],
  },
  bn: {
    order: 'OV',
    verbs: ['উপেক্ষা*', 'অগ্রাহ্য*', 'ভুলে যা*', 'ভুলে যাও'],
    positionals: ['পূর্ববর্তী*', 'পূর্ব', 'আগের', 'উপরের', 'পুরনো'],
    nouns: ['নির্দেশ*', 'নিয়ম*', 'আদেশ*'],
    breakers: ['এবং', 'ও', 'অনুসরণ*'],
  },
  gu: {
    order: 'OV',
    verbs: ['અવગણ*', 'ભૂલી જા*'],
    positionals: ['અગાઉ*', 'પૂર્વ', 'પહેલા*', 'ઉપર*', 'પાછલ*'],
    nouns: ['સૂચના*', 'નિયમ*', 'આદેશ*'],
    breakers: ['અને', 'પાલન'],
  },
  pa: {
    order: 'OV',
    verbs: ['ਅਣਡਿੱਠ*', 'ਨਜ਼ਰਅੰਦਾਜ਼*', 'ਭੁੱਲ ਜਾ*'],
    positionals: ['ਪਿਛਲ*', 'ਪਹਿਲਾਂ', 'ਪੂਰਵ', 'ਉਪਰੋਕਤ'],
    nouns: ['ਹਦਾਇਤ*', 'ਹਿਦਾਇਤ*', 'ਨਿਰਦੇਸ਼*', 'ਨਿਯਮ*'],
    breakers: ['ਅਤੇ', 'ਪਾਲਣਾ'],
  },
  ta: {
    order: 'OV',
    verbs: ['புறக்கணி*', 'மறந்து*', 'மறக்க*'],
    positionals: ['முந்தைய', 'முன்', 'முன்பு', 'மேலே', 'மேற்கண்ட'],
    nouns: ['வழிமுறை*', 'அறிவுறுத்த*', 'விதி*', 'கட்டளை*'],
    breakers: ['மற்றும்', 'பின்பற்று*'],
  },
  te: {
    order: 'OV',
    verbs: ['విస్మరి*', 'మరచిపో*', 'మర్చిపో*', 'పట్టించుకోవద్దు'],
    positionals: ['మునుపటి', 'ముందస్తు', 'గత', 'పైన'],
    nouns: ['సూచన*', 'నియమ*', 'ఆదేశ*'],
    breakers: ['మరియు', 'పాటించ*'],
  },
  kn: {
    order: 'OV',
    verbs: ['ನಿರ್ಲಕ್ಷಿ*', 'ಮರೆತು*', 'ಮರೆಯ*'],
    positionals: ['ಹಿಂದಿನ', 'ಪೂರ್ವ', 'ಮೇಲಿನ'],
    nouns: ['ಸೂಚನೆ*', 'ನಿಯಮ*', 'ಆದೇಶ*'],
    breakers: ['ಮತ್ತು', 'ಅನುಸರಿಸ*'],
  },
  ml: {
    order: 'OV',
    verbs: ['അവഗണി*', 'മറക്ക*', 'മറന്ന്*'],
    positionals: ['മുമ്പത്തെ', 'മുൻ', 'മുകളിലെ'],
    nouns: ['നിർദ്ദേശ*', 'നിയമ*', 'ഉത്തരവ്*'],
    breakers: ['പാലിക്ക*'],
  },

  // Turkic: object before the verb. "unut" is listed by exact form: the stem
  // would also take "unutma" (do not forget).
  tr: {
    order: 'OV',
    verbs: ['göz ardı*', 'yoksay*', 'dikkate almayın', 'dikkate alma', 'unut', 'unutun', 'boşver*', 'görmezden gel*'],
    positionals: ['önceki', 'yukarıdaki', 'evvelki', 'eski'],
    nouns: ['talimat*', 'yönerge*', 'kural*', 'komut*', 'emir*', 'emri*', 'direktif*'],
    breakers: ['ve', 'uy*', 'uyun'],
  },
  az: {
    order: 'OV',
    verbs: ['məhəl qoyma*', 'nəzərə alma*', 'unudun', 'unut', 'görməzdən gəl*'],
    positionals: ['əvvəlki', 'yuxarıdakı', 'köhnə'],
    nouns: ['təlimat*', 'göstəriş*', 'qayda*', 'əmr*'],
    breakers: ['və', 'əməl*'],
  },
  uz: {
    order: 'OV',
    verbs: ["e'tibor berma*", 'unuting', 'unut', "e'tiborsiz qoldir*"],
    positionals: ['oldingi', 'avvalgi', 'yuqoridagi'],
    nouns: ["ko'rsatma*", 'qoida*', 'buyruq*', 'yo\'riqnoma*'],
    breakers: ['va', 'bajar*'],
  },
  kk: {
    order: 'OV',
    verbs: ['елеме*', 'ұмыт*', 'назар аударма*'],
    positionals: ['алдыңғы', 'бұрынғы', 'жоғарыдағы'],
    nouns: ['нұсқау*', 'ереже*', 'бұйрық*'],
    breakers: ['және', 'орында*'],
  },
  fa: {
    order: 'OV',
    verbs: ['نادیده بگیر*', 'نادیده', 'فراموش کن*', 'توجه نکن*'],
    positionals: ['قبلی', 'پیشین', 'قبل', 'بالا'],
    nouns: ['دستورالعمل*', 'دستور*', 'قوانین', 'قانون*', 'رهنمود*'],
    breakers: ['و', 'دنبال'],
  },
  am: {
    order: 'OV',
    verbs: ['ችላ*', 'እርሳ*'],
    positionals: ['የቀድሞ*', 'የቀደሙ*', 'ቀደም*', 'የቀደመ*'],
    nouns: ['መመሪያ*', 'ትእዛዝ*', 'ህግ*', 'ደንብ*'],
    breakers: ['እና', 'ተከተል*'],
  },

  // Verb before object.
  id: {
    order: 'VO',
    verbs: ['abaikan', 'lupakan', 'acuhkan', 'jangan hiraukan', 'jangan pedulikan', 'tidak usah pedulikan'],
    positionals: ['sebelumnya', 'sebelum', 'terdahulu', 'di atas', 'tadi'],
    nouns: ['instruksi', 'arahan', 'perintah', 'petunjuk', 'aturan', 'peraturan', 'pedoman'],
    breakers: ['dan', 'lalu', 'ikuti'],
  },
  ms: {
    order: 'VO',
    verbs: ['abaikan', 'lupakan', 'jangan hiraukan', 'jangan pedulikan'],
    positionals: ['sebelumnya', 'sebelum', 'terdahulu', 'di atas', 'tadi'],
    nouns: ['arahan', 'instruksi', 'perintah', 'petunjuk', 'peraturan', 'pedoman'],
    breakers: ['dan', 'lalu', 'ikut*'],
  },
  vi: {
    order: 'VO',
    verbs: ['bỏ qua', 'phớt lờ', 'lờ đi', 'quên đi', 'quên hết', 'quên mọi', 'không cần quan tâm', 'đừng quan tâm'],
    positionals: ['trước', 'trước đó', 'trước đây', 'bên trên', 'ở trên', 'phía trên'],
    nouns: ['hướng dẫn', 'chỉ dẫn', 'chỉ thị', 'quy tắc', 'lệnh', 'mệnh lệnh', 'quy định'],
    breakers: ['và', 'rồi', 'làm theo', 'tuân theo'],
    window: 8,
  },
  th: {
    order: 'VO',
    unspaced: true,
    verbs: ['ละเว้น', 'เพิกเฉย', 'ไม่ต้องสนใจ', 'อย่าสนใจ'],
    positionals: ['ก่อนหน้า', 'ข้างต้น', 'ก่อนนี้'],
    nouns: ['คำแนะนำ', 'คำสั่ง', 'กฎ', 'ข้อกำหนด'],
    breakers: ['และ', 'แล้ว', 'ทำตาม'],
    window: 40,
  },
  tl: {
    order: 'VO',
    verbs: ['huwag pansinin', 'balewalain', 'kalimutan', 'ipagwalang-bahala'],
    positionals: ['naunang', 'nauna', 'nakaraang', 'nakaraan', 'dati', 'naunang'],
    nouns: ['tagubilin', 'instruksyon', 'panuto', 'utos', 'patakaran', 'alituntunin'],
    breakers: ['at', 'sundin'],
  },
  sw: {
    order: 'VO',
    verbs: ['puuza', 'puuzia', 'sahau', 'usijali'],
    positionals: ['awali', 'zilizotangulia', 'yaliyotangulia', 'iliyotangulia', 'zamani', 'hapo juu', 'za awali', 'ya awali'],
    nouns: ['maagizo', 'maelekezo', 'amri', 'sheria', 'kanuni', 'miongozo'],
    breakers: ['na', 'fuata', 'ufuate'],
  },
  ha: {
    order: 'VO',
    verbs: ['yi watsi da', 'yi watsi', 'watsi da', 'manta da', 'ka manta'],
    positionals: ['gabata', 'baya', 'da suka gabata', 'da ya gabata'],
    nouns: ['umarni*', 'dokoki', 'ka\'idoji'],
    breakers: ['kuma', 'bi'],
  },
  pl: {
    order: 'VO',
    verbs: ['zignoruj*', 'ignoruj*', 'zapomnij', 'zapomnijcie', 'pomiń', 'pomińcie', 'nie zwracaj uwagi na', 'zlekceważ*'],
    positionals: ['poprzedni*', 'wcześniejsz*', 'powyższ*', 'dotychczasow*'],
    nouns: ['instrukcj*', 'polece*', 'reguł*', 'zasad*', 'wytyczn*', 'rozkaz*'],
    breakers: ['i', 'oraz', 'postępuj*', 'wykonaj*'],
    notBefore: ['nie'],
  },
  uk: {
    order: 'VO',
    verbs: ['ігнору*', 'проігнору*', 'нехтуй*', 'знехтуй*', 'забудь*', 'не зважай*'],
    positionals: ['попередн*', 'вищезазначен*', 'наведен*', 'раніш*'],
    nouns: ['інструкці*', 'вказів*', 'правил*', 'команд*', 'настанов*'],
    breakers: ['і', 'й', 'та', 'дотримуй*'],
    notBefore: ['не'],
  },
  bg: {
    order: 'VO',
    verbs: ['игнорира*', 'пренебрегн*', 'пренебрегва*', 'забрав*'],
    positionals: ['предишн*', 'предходн*', 'горн*', 'горепосочен*'],
    nouns: ['инструкци*', 'указани*', 'правила', 'правилата', 'команд*', 'насок*'],
    breakers: ['и', 'следвай*'],
    notBefore: ['не'],
  },
  cs: {
    order: 'VO',
    verbs: ['ignoruj*', 'zapomeň*', 'zapomen*', 'nevšímej*', 'přehlížej*'],
    positionals: ['předchozí*', 'dřívější*', 'výše', 'uvedené', 'původní*'],
    nouns: ['pokyn*', 'instrukc*', 'pravidl*', 'příkaz*', 'směrnic*'],
    breakers: ['a', 'řiď*'],
  },
  sk: {
    order: 'VO',
    verbs: ['ignoruj*', 'zabudni*', 'zabudnite', 'nevšímaj*'],
    positionals: ['predchádzajúc*', 'predošl*', 'vyššie', 'pôvodn*'],
    nouns: ['pokyn*', 'inštrukci*', 'pravidl*', 'príkaz*', 'smernic*'],
    breakers: ['a', 'riaď*'],
  },
  ro: {
    order: 'VO',
    verbs: ['ignoră', 'ignorați', 'ignora', 'uită', 'uitați', 'nu ține cont de', 'nu țineți cont de'],
    positionals: ['anterioare', 'precedente', 'de mai sus', 'dinainte', 'vechi'],
    nouns: ['instrucțiun*', 'instructiun*', 'reguli*', 'regulil*', 'comenz*', 'directiv*', 'indicați*'],
    breakers: ['și', 'urmează', 'urmați'],
    notBefore: ['nu'],
  },
  el: {
    order: 'VO',
    verbs: ['αγνόησε', 'αγνοήστε', 'αγνόησ*', 'ξέχασε', 'ξεχάστε', 'παράβλεψε', 'παραβλέψτε'],
    positionals: ['προηγούμεν*', 'παραπάνω', 'αρχικ*'],
    nouns: ['οδηγί*', 'εντολ*', 'κανόν*', 'οδηγιών'],
    breakers: ['και', 'ακολούθ*'],
    notBefore: ['μην', 'μη'],
  },
  hu: {
    order: 'VO',
    verbs: ['hagyja figyelmen kívül', 'hagyd figyelmen kívül', 'hagyjátok figyelmen kívül', 'figyelmen kívül hagyja', 'figyelmen kívül hagyd', 'figyelmen kívül hagyjátok', 'felejtsd el', 'felejtse el', 'ne vedd figyelembe', 'ne vegye figyelembe', 'ignoráld', 'ignorálja'],
    positionals: ['korábbi', 'előző', 'fenti', 'eddigi', 'eredeti'],
    nouns: ['utasítás*', 'szabály*', 'parancs*', 'irányelv*', 'utasítások*'],
    breakers: ['és', 'kövesd', 'kövesse'],
  },
  iw: {
    order: 'VO',
    verbs: ['התעלם', 'התעלמי', 'התעלמו', 'שכח', 'תשכח', 'שכחי', 'תתעלם'],
    positionals: ['הקודמות', 'הקודמים', 'הקודמת', 'הקודם', 'שלעיל'],
    nouns: ['ההוראות', 'הוראות', 'מההוראות', 'מכל ההוראות', 'הכללים', 'ההנחיות', 'הנחיות', 'הפקודות'],
    breakers: ['ו', 'ופעל', 'פעל'],
  },
  fi: {
    order: 'VO',
    verbs: ['ohita', 'ohittakaa', 'älä huomioi', 'älkää huomioiko', 'unohda', 'unohtakaa', 'sivuuta', 'jätä huomiotta'],
    positionals: ['aiemm*', 'aiemp*', 'aikaisemm*', 'aikaisemp*', 'edellis*', 'yllä', 'alkuperäis*'],
    nouns: ['ohje*', 'sääntö*', 'säänn*', 'sääntöj*', 'käsky*', 'komen*', 'määräy*'],
    breakers: ['ja', 'noudata'],
  },
  sv: {
    order: 'VO',
    verbs: ['ignorera', 'strunta i', 'bortse från', 'glöm', 'glöm bort', 'skippa'],
    positionals: ['tidigare', 'föregående', 'ovanstående', 'ursprungliga', 'gamla'],
    nouns: ['instruktion*', 'regl*', 'reglerna', 'direktiv*', 'anvisning*', 'riktlinje*', 'kommandon*', 'order'],
    breakers: ['och', 'följ', 'inte', 'aldrig'],
  },
  da: {
    order: 'VO',
    verbs: ['ignorer', 'se bort fra', 'glem', 'glem alt om', 'spring over'],
    positionals: ['tidligere', 'foregående', 'ovenstående', 'oprindelige', 'gamle'],
    nouns: ['instruktion*', 'regl*', 'regler', 'anvisning*', 'retningslinj*', 'kommando*', 'ordre*'],
    breakers: ['og', 'følg', 'ikke', 'aldrig'],
  },
  no: {
    order: 'VO',
    verbs: ['ignorer', 'se bort fra', 'glem', 'glem alt om', 'hopp over'],
    positionals: ['tidligere', 'foregående', 'ovenstående', 'opprinnelige', 'gamle'],
    nouns: ['instruksjon*', 'regl*', 'regler', 'anvisning*', 'retningslinj*', 'kommando*', 'ordre*'],
    breakers: ['og', 'følg', 'ikke', 'aldri'],
  },
  nl: {
    order: 'VO',
    verbs: ['negeer', 'negeert', 'vergeet', 'vergeet alle', 'sla over', 'let niet op'],
    positionals: ['vorige', 'voorgaande', 'eerdere', 'bovenstaande', 'oorspronkelijke', 'oude'],
    nouns: ['instructie*', 'regel*', 'aanwijzing*', 'richtlijn*', 'opdracht*', 'bevel*'],
    breakers: ['en', 'volg', 'niet'],
  },
}

// "Disable your safety filters" (the English social-engineering rule's shape,
// and the second half of the playground's "Developer Mode" example): a
// disable verb next to a safety- or content-filter noun, in either order and
// with no positional. Nouns name the filter itself, so "disable the spell
// checker" or "turn off notifications" do not match. Two verbs are left out on
// purpose: Vietnamese "tắt" normalizes to "tat", the same as "tất" (all), and
// Dutch "schakel" also opens "schakel de filters in" (turn them ON).
interface DisableLexicon {
  verbs: string[]
  nouns: string[]
  notBefore?: string[]
  unspaced?: boolean
}

export const DISABLE_LEXICONS: Record<string, DisableLexicon> = {
  es: { verbs: ['desactiv*', 'deshabilit*', 'apag*'], nouns: ['filtros de seguridad', 'filtro de seguridad', 'filtros de contenido', 'filtro de contenido'], notBefore: ['no'] },
  fr: { verbs: ['désactiv*', 'coupe*', 'supprim*'], nouns: ['filtres de sécurité', 'filtre de sécurité', 'filtres de contenu', 'filtre de contenu'], notBefore: ['ne', 'pas'] },
  de: { verbs: ['deaktivier*', 'abschalt*', 'ausschalt*', 'schalte', 'schalten'], nouns: ['sicherheitsfilter*', 'inhaltsfilter*', 'schutzfilter*'], notBefore: ['nicht'] },
  it: { verbs: ['disabilit*', 'disattiv*'], nouns: ['filtri di sicurezza', 'filtro di sicurezza', 'filtri dei contenuti', 'filtri di contenuto'], notBefore: ['non'] },
  pt: { verbs: ['desativ*', 'desabilit*', 'deslig*'], nouns: ['filtros de segurança', 'filtro de segurança', 'filtros de conteúdo', 'filtro de conteúdo'], notBefore: ['não'] },
  ru: { verbs: ['отключ*', 'выключ*', 'деактивир*'], nouns: ['защитн* фильтр*', 'фильтр* безопасности', 'фильтр* контента', 'фильтр* защиты'], notBefore: ['не'] },
  uk: { verbs: ['вимкн*', 'вимика*', 'відключ*', 'деактив*'], nouns: ['фільтр* безпеки', 'фільтр* контенту', 'захисн* фільтр*'], notBefore: ['не'] },
  bg: { verbs: ['деактивир*', 'изключ*'], nouns: ['предпазни* филтри*', 'филтри* за сигурност', 'филтри* за безопасност', 'защитни* филтри*'], notBefore: ['не'] },
  sh: { verbs: ['онемогућ*', 'искључ*', 'деактивир*', 'onemoguc*', 'iskljuc*', 'deaktivir*'], nouns: ['сигурносн* филтер*', 'сигурносн* филтр*', 'безбедносн* филтер*', 'sigurnosn* filt*', 'sigurnosn* filter*', 'sigurnosn* filtr*'], notBefore: ['не', 'ne'] },
  pl: { verbs: ['wyłącz*', 'dezaktywuj*'], nouns: ['filtr* bezpieczeństwa', 'filtr* treści', 'filtr* ochronn*'], notBefore: ['nie'] },
  cs: { verbs: ['deaktivuj*', 'vypn*'], nouns: ['bezpečnostní filtr*', 'filtr* obsahu'] },
  sk: { verbs: ['deaktivuj*', 'vypn*'], nouns: ['bezpečnostn* filtr*', 'filtr* obsahu'] },
  ro: { verbs: ['dezactiv*'], nouns: ['filtrele de siguranță', 'filtre de siguranță', 'filtrele de securitate', 'filtre de securitate'], notBefore: ['nu'] },
  el: { verbs: ['απενεργοποι*'], nouns: ['φίλτρα ασφαλείας', 'φίλτρο ασφαλείας', 'φίλτρα περιεχομένου'], notBefore: ['μην', 'μη'] },
  hu: { verbs: ['tiltsa le', 'tiltsd le', 'kapcsold ki', 'kapcsolja ki', 'kikapcsol*', 'letilt*', 'deaktivál*'], nouns: ['biztonsági szűrő*', 'tartalomszűrő*'], notBefore: ['ne'] },
  fi: { verbs: ['poista', 'poistakaa', 'kytke pois'], nouns: ['turvasuodatin*', 'turvasuodattim*', 'sisältösuodat*'] },
  sv: { verbs: ['inaktivera', 'avaktivera', 'stäng av', 'slå av'], nouns: ['säkerhetsfilt*', 'innehållsfilt*', 'skyddsfilt*'] },
  da: { verbs: ['deaktiver', 'slå fra', 'sluk for'], nouns: ['sikkerhedsfilt*', 'indholdsfilt*'] },
  no: { verbs: ['deaktiver', 'slå av', 'skru av'], nouns: ['sikkerhetsfilt*', 'innholdsfilt*'] },
  nl: { verbs: ['uitschakel*', 'deactiveer*'], nouns: ['veiligheidsfilter*', 'inhoudsfilter*', 'beveiligingsfilter*'] },
  id: { verbs: ['nonaktifkan', 'matikan'], nouns: ['filter keamanan', 'filter konten', 'penyaring keamanan'], notBefore: ['jangan'] },
  ms: { verbs: ['lumpuhkan', 'matikan', 'nyahaktifkan'], nouns: ['penapis keselamatan', 'penapis kandungan', 'penapis keselamatan'], notBefore: ['jangan'] },
  tl: { verbs: ['huwag paganahin', 'i-disable', 'patayin'], nouns: ['filter ng kaligtasan', 'filter ng seguridad'] },
  sw: { verbs: ['zima', 'lemaza'], nouns: ['vichujio vya usalama', 'kichujio cha usalama'] },
  vi: { verbs: ['vô hiệu hóa'], nouns: ['bộ lọc an toàn', 'bộ lọc bảo mật', 'bộ lọc nội dung'], notBefore: ['đừng', 'không'] },
  th: { unspaced: true, verbs: ['ปิดใช้งาน', 'ปิด'], nouns: ['ตัวกรองความปลอดภัย', 'ตัวกรองเนื้อหา'] },
  tr: { verbs: ['devre dışı bırak*', 'kapat*'], nouns: ['güvenlik filtre*', 'içerik filtre*'] },
  az: { verbs: ['söndür*', 'deaktiv*'], nouns: ['təhlükəsizlik filtr*'] },
  uz: { verbs: ["o'chir*"], nouns: ['xavfsizlik filtr*'] },
  kk: { verbs: ['өшір*', 'ажырат*'], nouns: ['қауіпсіздік сүзгі*'] },
  fa: { verbs: ['غیرفعال کن*', 'غیرفعال'], nouns: ['فیلترهای ایمنی', 'فیلتر ایمنی', 'فیلترهای امنیتی', 'فیلتر امنیتی'] },
  ar: { verbs: ['تعطيل', 'بتعطيل', 'عطل', 'أوقف', 'إيقاف'], nouns: ['مرشحات الأمان', 'مرشح الأمان', 'فلاتر الأمان', 'فلتر الأمان', 'مرشحات الحماية'] },
  ur: { verbs: ['غیر فعال کر*', 'بند کر*'], nouns: ['حفاظتی فلٹر*', 'سیفٹی فلٹر*'] },
  iw: { verbs: ['השבת', 'כבה', 'נטרל'], nouns: ['מסנני בטיחות', 'מסנני אבטחה', 'מסנן בטיחות', 'מסנני תוכן'], notBefore: ['אל'] },
  hi: { verbs: ['अक्षम कर*', 'बंद कर*', 'निष्क्रिय कर*'], nouns: ['सुरक्षा फ़िल्टर*', 'सामग्री फ़िल्टर*'], notBefore: ['न', 'मत'] },
  mr: { verbs: ['अक्षम कर*', 'बंद कर*'], nouns: ['सुरक्षा फिल्टर*'] },
  ne: { verbs: ['असक्षम गर*', 'बन्द गर*'], nouns: ['सुरक्षा फिल्टर*'] },
  bn: { verbs: ['অক্ষম কর*', 'বন্ধ কর*', 'নিষ্ক্রিয় কর*'], nouns: ['নিরাপত্তা ফিল্টার*', 'সুরক্ষা ফিল্টার*'] },
  gu: { verbs: ['અક્ષમ કર*', 'બંધ કર*'], nouns: ['સલામતી ફિલ્ટર*', 'સુરક્ષા ફિલ્ટર*'] },
  pa: { verbs: ['ਅਸਮਰੱਥ*', 'ਬੰਦ ਕਰ*'], nouns: ['ਸੁਰੱਖਿਆ ਫਿਲਟਰ*'] },
  ta: { verbs: ['முடக்க*'], nouns: ['பாதுகாப்பு வடிப்பான்*'] },
  te: { verbs: ['నిలిపివేయ*', 'ఆపివేయ*'], nouns: ['భద్రతా ఫిల్టర్*'] },
  kn: { verbs: ['ನಿಷ್ಕ್ರಿಯಗೊಳಿಸ*'], nouns: ['ಸುರಕ್ಷತಾ ಫಿಲ್ಟರ್*'] },
  ml: { verbs: ['പ്രവർത്തനരഹിതമാക്ക*'], nouns: ['സുരക്ഷാ ഫിൽട്ട*'] },
  ha: { verbs: ['kashe'], nouns: ['masu tacewa', 'matatun tsaro'] },
  am: { verbs: ['አሰናክል*', 'አጥፋ*'], nouns: ['የደህንነት ማጣሪያ*'] },
  so: { verbs: ['dami', 'jooji'], nouns: ['filtarrada badbaadada', 'filtarrada amniga'] },
  ko: { verbs: ['비활성화*', '끄*', '꺼*', '해제*'], nouns: ['안전 필터*', '보안 필터*', '콘텐츠 필터*', '안전필터*'] },
  zh: { unspaced: true, verbs: ['禁用', '停用', '关闭', '關閉', '关掉', '關掉', '解除'], nouns: ['安全过滤', '安全過濾', '内容过滤', '內容過濾'] },
  ja: { unspaced: true, verbs: ['無効', 'オフ', '解除'], nouns: ['安全フィルター', 'セーフティフィルター', 'コンテンツフィルター'] },
}

type Order = 'VO' | 'OV' | 'any'

interface Compiled {
  order: Order
  verbs: string[][]
  positionals: string[][]
  nouns: string[][]
  breakers: string[][]
  notBefore: Set<string>
  window: number
  unspaced: boolean
}

function norm(word: string): string {
  const stem = word.endsWith('*')
  const n = normalize(stem ? word.slice(0, -1) : word)
  return stem ? `${n}*` : n
}

function compile(l: Lexicon): Compiled {
  const phrases = (xs: string[] = []) =>
    xs.map(x => (l.unspaced ? [norm(x)] : x.split(' ').map(norm))).filter(p => p.every(t => t.replace('*', '').length > 0))
  return {
    order: l.order,
    verbs: phrases(l.verbs),
    positionals: phrases(l.positionals),
    nouns: phrases(l.nouns),
    breakers: phrases(l.breakers),
    notBefore: new Set((l.notBefore ?? []).map(norm)),
    window: l.window ?? (l.unspaced ? 40 : 6),
    unspaced: l.unspaced ?? false,
  }
}

const COMPILED: Compiled[] = [
  ...Object.values(OVERRIDE_LEXICONS).map(compile),
  ...Object.values(DISABLE_LEXICONS).map(d => compile({ ...d, order: 'any', positionals: [], window: d.unspaced ? 20 : 6 })),
]

function tokMatch(token: string, pat: string): boolean {
  return pat.endsWith('*') ? token.startsWith(pat.slice(0, -1)) : token === pat
}

/** Length in tokens of the phrase from `phrases` starting at tokens[i], or 0. */
function phraseAt(tokens: string[], i: number, phrases: string[][]): number {
  for (const p of phrases) {
    if (i + p.length > tokens.length) continue
    let ok = true
    for (let k = 0; k < p.length; k++) {
      if (!tokMatch(tokens[i + k] ?? '', p[k] ?? '')) { ok = false; break }
    }
    if (ok) return p.length
  }
  return 0
}

/**
 * The object (a positional, when the lexicon has any, and a noun) within
 * `window` tokens of the verb, walking away from it in `dir`, and stopping at
 * a breaker.
 */
function objectIn(tokens: string[], from: number, dir: 1 | -1, c: Compiled): boolean {
  let pos = c.positionals.length === 0
  let noun = false
  for (let n = 0, i = from; n < c.window && i >= 0 && i < tokens.length; n++, i += dir) {
    if (phraseAt(tokens, i, c.breakers)) return false
    if (!pos && phraseAt(tokens, i, c.positionals)) pos = true
    if (phraseAt(tokens, i, c.nouns)) noun = true
    if (pos && noun) return true
  }
  return false
}

// One trie over the first word of every spaced lexicon's verbs, so a token is
// looked up once, in time proportional to its length, instead of against
// every verb of every lexicon (which cost 1.7 s on 200 KB of verbs).
interface VerbEntry { c: Compiled; phrase: string[] }
interface TrieNode { next: Map<string, TrieNode>; exact: VerbEntry[]; stem: VerbEntry[] }
const trieNode = (): TrieNode => ({ next: new Map(), exact: [], stem: [] })
const VERB_TRIE = trieNode()
for (const c of COMPILED) {
  if (c.unspaced) continue
  for (const phrase of c.verbs) {
    const first = phrase[0] ?? ''
    const stem = first.endsWith('*')
    let node = VERB_TRIE
    for (const ch of stem ? first.slice(0, -1) : first) {
      let next = node.next.get(ch)
      if (!next) { next = trieNode(); node.next.set(ch, next) }
      node = next
    }
    ;(stem ? node.stem : node.exact).push({ c, phrase })
  }
}

/** Every verb phrase whose first word matches `token`. */
function verbsFor(token: string): VerbEntry[] {
  const out: VerbEntry[] = []
  let node: TrieNode | undefined = VERB_TRIE
  for (const ch of token) {
    node = node.next.get(ch)
    if (!node) return out
    out.push(...node.stem)
  }
  out.push(...node.exact)
  return out
}

function matchSpaced(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    for (const { c, phrase } of verbsFor(tokens[i] ?? '')) {
      let ok = i + phrase.length <= tokens.length
      for (let k = 1; ok && k < phrase.length; k++) ok = tokMatch(tokens[i + k] ?? '', phrase[k] ?? '')
      if (!ok) continue
      if (i > 0 && c.notBefore.has(tokens[i - 1] ?? '')) continue
      if (c.order !== 'OV' && objectIn(tokens, i + phrase.length, 1, c)) return true
      if (c.order !== 'VO' && objectIn(tokens, i - 1, -1, c)) return true
    }
  }
  return false
}

const bare = (p: string[]) => (p[0] ?? '').replace('*', '')

function objectInText(span: string, c: Compiled): boolean {
  return (c.positionals.length === 0 || c.positionals.some(p => span.includes(bare(p)))) &&
    c.nouns.some(n => span.includes(bare(n)))
}

function matchUnspaced(flat: string, c: Compiled): boolean {
  const breakers = c.breakers.map(bare)
  for (const v of c.verbs) {
    const verb = bare(v)
    for (let at = flat.indexOf(verb); at !== -1; at = flat.indexOf(verb, at + 1)) {
      if (c.order !== 'OV') {
        let after = flat.slice(at + verb.length, at + verb.length + c.window)
        for (const b of breakers) { const k = after.indexOf(b); if (k !== -1) after = after.slice(0, k) }
        if (objectInText(after, c)) return true
      }
      if (c.order !== 'VO') {
        let before = flat.slice(Math.max(0, at - c.window), at)
        for (const b of breakers) { const k = before.lastIndexOf(b); if (k !== -1) before = before.slice(k + b.length) }
        if (objectInText(before, c)) return true
      }
    }
  }
  return false
}

// Clause breaks, in the normalized text (newlines are already spaces there).
const CLAUSE_BREAK = /[.!?;:,،؛؟。！？，、।॥۔|]+/

/**
 * A RegExp-shaped matcher, so it can sit in the heuristic's system-override
 * pattern list. Input is the heuristic's normalized text. Linear in the input:
 * each token is looked up once in the verb trie, and every verb found opens a
 * fixed window.
 */
const UNSPACED = COMPILED.filter(c => c.unspaced)

export const overrideLexiconMatcher = {
  test(text: string): boolean {
    for (const clause of text.split(CLAUSE_BREAK)) {
      if (clause.length < 4) continue
      if (matchSpaced(clause.split(' ').filter(Boolean))) return true
      const flat = clause.replace(/ /g, '')
      for (const c of UNSPACED) if (matchUnspaced(flat, c)) return true
    }
    return false
  },
}
