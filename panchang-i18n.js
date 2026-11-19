/* ==========================================================================
   panchang-i18n.js — Panchang words in English and Indian languages.

   Each language gives: paksha words (waxing, waning), the 14 tithi names +
   Purnima + Amavasya, 27 nakshatras, 12 rasis, the special days, field labels,
   a "name till time, then next" pattern, and a suggested reference city.
   Terms follow each language's common Panchang usage (e.g. Gujarati Sud/Vad,
   Malayalam rasi Medam..Meenam, Telugu Padyami..). English uses the
   pan-Indian (Sanskrit) forms; "Tamil names in English letters" keeps the
   Tamil forms in Latin script.
   ========================================================================== */
(function (root) {
  'use strict';

  const L = {
    en: {
      label: 'English', locale: 'en-IN', place: 'delhi',
      paksha: ['Shukla', 'Krishna'],
      tithi: ['Pratipada', 'Dwitiya', 'Tritiya', 'Chaturthi', 'Panchami', 'Shashthi', 'Saptami', 'Ashtami', 'Navami',
        'Dashami', 'Ekadashi', 'Dwadashi', 'Trayodashi', 'Chaturdashi', 'Purnima', 'Amavasya'],
      nakshatra: ['Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha',
        'Magha', 'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra', 'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha',
        'Mula', 'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishtha', 'Shatabhisha', 'Purva Bhadrapada',
        'Uttara Bhadrapada', 'Revati'],
      rasi: ['Mesha (Aries)', 'Vrishabha (Taurus)', 'Mithuna (Gemini)', 'Karka (Cancer)', 'Simha (Leo)', 'Kanya (Virgo)',
        'Tula (Libra)', 'Vrishchika (Scorpio)', 'Dhanu (Sagittarius)', 'Makara (Capricorn)', 'Kumbha (Aquarius)', 'Meena (Pisces)'],
      special: { pradosham: 'Pradosham', soma: 'Soma Pradosham', shani: 'Shani Pradosham', ekadasi: 'Ekadashi' },
      labels: { tithi: 'Tithi', nakshatra: 'Nakshatra', rasi: 'Rasi', sunrise: 'Sunrise', sunset: 'Sunset' },
      till: (n, t, next) => `${n} till ${t}, then ${next}`,
    },
    'ta-Latn': {
      label: 'Tamil names in English letters', locale: 'en-IN', place: 'chennai',
      paksha: ['Valarpirai', 'Theipirai'],
      tithi: ['Prathamai', 'Dhvitiyai', 'Thrithiyai', 'Chathurthi', 'Panchami', 'Sashti', 'Sapthami', 'Ashtami', 'Navami',
        'Dhasami', 'Ekadasi', 'Dhvadasi', 'Thrayodasi', 'Chathurdasi', 'Pournami', 'Amavasai'],
      nakshatra: ['Ashwini', 'Bharani', 'Karthigai', 'Rohini', 'Mirugasirisham', 'Thiruvathirai', 'Punarpoosam', 'Poosam',
        'Ayilyam', 'Magam', 'Pooram', 'Uthiram', 'Hastham', 'Chithirai', 'Swathi', 'Visakam', 'Anusham', 'Kettai',
        'Moolam', 'Pooradam', 'Uthiradam', 'Thiruvonam', 'Avittam', 'Sadhayam', 'Poorattathi', 'Uthirattathi', 'Revathi'],
      rasi: ['Mesham', 'Rishabam', 'Mithunam', 'Kadagam', 'Simmam', 'Kanni', 'Thulam', 'Viruchigam', 'Dhanusu', 'Magaram',
        'Kumbam', 'Meenam'],
      special: { pradosham: 'Pradosham', soma: 'Soma Pradosham', shani: 'Sani Pradosham', ekadasi: 'Ekadasi' },
      labels: { tithi: 'Thithi', nakshatra: 'Natchathiram', rasi: 'Rasi', sunrise: 'Sunrise', sunset: 'Sunset' },
      till: (n, t, next) => `${n} till ${t}, then ${next}`,
    },
    hi: {
      label: 'हिन्दी (Hindi)', locale: 'hi-IN', place: 'delhi',
      paksha: ['शुक्ल', 'कृष्ण'],
      tithi: ['प्रतिपदा', 'द्वितीया', 'तृतीया', 'चतुर्थी', 'पंचमी', 'षष्ठी', 'सप्तमी', 'अष्टमी', 'नवमी', 'दशमी', 'एकादशी',
        'द्वादशी', 'त्रयोदशी', 'चतुर्दशी', 'पूर्णिमा', 'अमावस्या'],
      nakshatra: ['अश्विनी', 'भरणी', 'कृत्तिका', 'रोहिणी', 'मृगशिरा', 'आर्द्रा', 'पुनर्वसु', 'पुष्य', 'आश्लेषा', 'मघा',
        'पूर्वा फाल्गुनी', 'उत्तरा फाल्गुनी', 'हस्त', 'चित्रा', 'स्वाति', 'विशाखा', 'अनुराधा', 'ज्येष्ठा', 'मूल', 'पूर्वाषाढ़ा',
        'उत्तराषाढ़ा', 'श्रवण', 'धनिष्ठा', 'शतभिषा', 'पूर्वा भाद्रपद', 'उत्तरा भाद्रपद', 'रेवती'],
      rasi: ['मेष', 'वृषभ', 'मिथुन', 'कर्क', 'सिंह', 'कन्या', 'तुला', 'वृश्चिक', 'धनु', 'मकर', 'कुंभ', 'मीन'],
      special: { pradosham: 'प्रदोष व्रत', soma: 'सोम प्रदोष', shani: 'शनि प्रदोष', ekadasi: 'एकादशी' },
      labels: { tithi: 'तिथि', nakshatra: 'नक्षत्र', rasi: 'राशि', sunrise: 'सूर्योदय', sunset: 'सूर्यास्त' },
      till: (n, t, next) => `${n} ${t} तक, फिर ${next}`,
    },
    bn: {
      label: 'বাংলা (Bengali)', locale: 'bn-IN', place: 'kolkata',
      paksha: ['শুক্ল', 'কৃষ্ণ'],
      tithi: ['প্রতিপদ', 'দ্বিতীয়া', 'তৃতীয়া', 'চতুর্থী', 'পঞ্চমী', 'ষষ্ঠী', 'সপ্তমী', 'অষ্টমী', 'নবমী', 'দশমী', 'একাদশী',
        'দ্বাদশী', 'ত্রয়োদশী', 'চতুর্দশী', 'পূর্ণিমা', 'অমাবস্যা'],
      nakshatra: ['অশ্বিনী', 'ভরণী', 'কৃত্তিকা', 'রোহিণী', 'মৃগশিরা', 'আর্দ্রা', 'পুনর্বসু', 'পুষ্যা', 'অশ্লেষা', 'মঘা',
        'পূর্বফাল্গুনী', 'উত্তরফাল্গুনী', 'হস্তা', 'চিত্রা', 'স্বাতী', 'বিশাখা', 'অনুরাধা', 'জ্যেষ্ঠা', 'মূলা', 'পূর্বাষাঢ়া',
        'উত্তরাষাঢ়া', 'শ্রবণা', 'ধনিষ্ঠা', 'শতভিষা', 'পূর্বভাদ্রপদ', 'উত্তরভাদ্রপদ', 'রেবতী'],
      rasi: ['মেষ', 'বৃষ', 'মিথুন', 'কর্কট', 'সিংহ', 'কন্যা', 'তুলা', 'বৃশ্চিক', 'ধনু', 'মকর', 'কুম্ভ', 'মীন'],
      special: { pradosham: 'প্রদোষ', soma: 'সোম প্রদোষ', shani: 'শনি প্রদোষ', ekadasi: 'একাদশী' },
      labels: { tithi: 'তিথি', nakshatra: 'নক্ষত্র', rasi: 'রাশি', sunrise: 'সূর্যোদয়', sunset: 'সূর্যাস্ত' },
      till: (n, t, next) => `${n} ${t} পর্যন্ত, তারপর ${next}`,
    },
    mr: {
      label: 'मराठी (Marathi)', locale: 'mr-IN', place: 'mumbai',
      paksha: ['शुक्ल', 'कृष्ण'],
      tithi: ['प्रतिपदा', 'द्वितीया', 'तृतीया', 'चतुर्थी', 'पंचमी', 'षष्ठी', 'सप्तमी', 'अष्टमी', 'नवमी', 'दशमी', 'एकादशी',
        'द्वादशी', 'त्रयोदशी', 'चतुर्दशी', 'पौर्णिमा', 'अमावास्या'],
      nakshatra: ['अश्विनी', 'भरणी', 'कृत्तिका', 'रोहिणी', 'मृग', 'आर्द्रा', 'पुनर्वसू', 'पुष्य', 'आश्लेषा', 'मघा',
        'पूर्वा फाल्गुनी', 'उत्तरा फाल्गुनी', 'हस्त', 'चित्रा', 'स्वाती', 'विशाखा', 'अनुराधा', 'ज्येष्ठा', 'मूळ', 'पूर्वाषाढा',
        'उत्तराषाढा', 'श्रवण', 'धनिष्ठा', 'शततारका', 'पूर्वा भाद्रपदा', 'उत्तरा भाद्रपदा', 'रेवती'],
      rasi: ['मेष', 'वृषभ', 'मिथुन', 'कर्क', 'सिंह', 'कन्या', 'तूळ', 'वृश्चिक', 'धनु', 'मकर', 'कुंभ', 'मीन'],
      special: { pradosham: 'प्रदोष', soma: 'सोम प्रदोष', shani: 'शनि प्रदोष', ekadasi: 'एकादशी' },
      labels: { tithi: 'तिथी', nakshatra: 'नक्षत्र', rasi: 'राशी', sunrise: 'सूर्योदय', sunset: 'सूर्यास्त' },
      till: (n, t, next) => `${n} ${t} पर्यंत, नंतर ${next}`,
    },
    te: {
      label: 'తెలుగు (Telugu)', locale: 'te-IN', place: 'hyderabad',
      paksha: ['శుక్ల', 'కృష్ణ'],
      tithi: ['పాడ్యమి', 'విదియ', 'తదియ', 'చవితి', 'పంచమి', 'షష్ఠి', 'సప్తమి', 'అష్టమి', 'నవమి', 'దశమి', 'ఏకాదశి',
        'ద్వాదశి', 'త్రయోదశి', 'చతుర్దశి', 'పౌర్ణమి', 'అమావాస్య'],
      nakshatra: ['అశ్విని', 'భరణి', 'కృత్తిక', 'రోహిణి', 'మృగశిర', 'ఆర్ద్ర', 'పునర్వసు', 'పుష్యమి', 'ఆశ్లేష', 'మఖ', 'పుబ్బ',
        'ఉత్తర', 'హస్త', 'చిత్త', 'స్వాతి', 'విశాఖ', 'అనూరాధ', 'జ్యేష్ఠ', 'మూల', 'పూర్వాషాఢ', 'ఉత్తరాషాఢ', 'శ్రవణం',
        'ధనిష్ఠ', 'శతభిషం', 'పూర్వాభాద్ర', 'ఉత్తరాభాద్ర', 'రేవతి'],
      rasi: ['మేషం', 'వృషభం', 'మిథునం', 'కర్కాటకం', 'సింహం', 'కన్య', 'తుల', 'వృశ్చికం', 'ధనుస్సు', 'మకరం', 'కుంభం', 'మీనం'],
      special: { pradosham: 'ప్రదోషం', soma: 'సోమ ప్రదోషం', shani: 'శని ప్రదోషం', ekadasi: 'ఏకాదశి' },
      labels: { tithi: 'తిథి', nakshatra: 'నక్షత్రం', rasi: 'రాశి', sunrise: 'సూర్యోదయం', sunset: 'సూర్యాస్తమయం' },
      till: (n, t, next) => `${n} ${t} వరకు, తర్వాత ${next}`,
    },
    ta: {
      label: 'தமிழ் (Tamil)', locale: 'ta-IN', place: 'chennai',
      paksha: ['வளர்பிறை', 'தேய்பிறை'],
      tithi: ['பிரதமை', 'துவிதியை', 'திருதியை', 'சதுர்த்தி', 'பஞ்சமி', 'சஷ்டி', 'சப்தமி', 'அஷ்டமி', 'நவமி', 'தசமி', 'ஏகாதசி',
        'துவாதசி', 'திரயோதசி', 'சதுர்த்தசி', 'பௌர்ணமி', 'அமாவாசை'],
      nakshatra: ['அசுவினி', 'பரணி', 'கார்த்திகை', 'ரோகிணி', 'மிருகசீரிடம்', 'திருவாதிரை', 'புனர்பூசம்', 'பூசம்', 'ஆயில்யம்',
        'மகம்', 'பூரம்', 'உத்திரம்', 'அஸ்தம்', 'சித்திரை', 'சுவாதி', 'விசாகம்', 'அனுஷம்', 'கேட்டை', 'மூலம்', 'பூராடம்',
        'உத்திராடம்', 'திருவோணம்', 'அவிட்டம்', 'சதயம்', 'பூரட்டாதி', 'உத்திரட்டாதி', 'ரேவதி'],
      rasi: ['மேஷம்', 'ரிஷபம்', 'மிதுனம்', 'கடகம்', 'சிம்மம்', 'கன்னி', 'துலாம்', 'விருச்சிகம்', 'தனுசு', 'மகரம்', 'கும்பம்', 'மீனம்'],
      special: { pradosham: 'பிரதோஷம்', soma: 'சோம பிரதோஷம்', shani: 'சனி பிரதோஷம்', ekadasi: 'ஏகாதசி' },
      labels: { tithi: 'திதி', nakshatra: 'நட்சத்திரம்', rasi: 'ராசி', sunrise: 'சூரிய உதயம்', sunset: 'சூரிய அஸ்தமனம்' },
      till: (n, t, next) => `${n} ${t} வரை, பின்னர் ${next}`,
    },
    gu: {
      label: 'ગુજરાતી (Gujarati)', locale: 'gu-IN', place: 'ahmedabad',
      paksha: ['સુદ', 'વદ'],
      tithi: ['પડવો', 'બીજ', 'ત્રીજ', 'ચોથ', 'પાંચમ', 'છઠ', 'સાતમ', 'આઠમ', 'નોમ', 'દશમ', 'અગિયારસ', 'બારસ', 'તેરસ', 'ચૌદસ',
        'પૂનમ', 'અમાસ'],
      nakshatra: ['અશ્વિની', 'ભરણી', 'કૃત્તિકા', 'રોહિણી', 'મૃગશીર્ષ', 'આર્દ્રા', 'પુનર્વસુ', 'પુષ્ય', 'આશ્લેષા', 'મઘા',
        'પૂર્વા ફાલ્ગુની', 'ઉત્તરા ફાલ્ગુની', 'હસ્ત', 'ચિત્રા', 'સ્વાતિ', 'વિશાખા', 'અનુરાધા', 'જ્યેષ્ઠા', 'મૂળ', 'પૂર્વાષાઢા',
        'ઉત્તરાષાઢા', 'શ્રવણ', 'ધનિષ્ઠા', 'શતભિષા', 'પૂર્વા ભાદ્રપદ', 'ઉત્તરા ભાદ્રપદ', 'રેવતી'],
      rasi: ['મેષ', 'વૃષભ', 'મિથુન', 'કર્ક', 'સિંહ', 'કન્યા', 'તુલા', 'વૃશ્ચિક', 'ધન', 'મકર', 'કુંભ', 'મીન'],
      special: { pradosham: 'પ્રદોષ', soma: 'સોમ પ્રદોષ', shani: 'શનિ પ્રદોષ', ekadasi: 'અગિયારસ' },
      labels: { tithi: 'તિથિ', nakshatra: 'નક્ષત્ર', rasi: 'રાશિ', sunrise: 'સૂર્યોદય', sunset: 'સૂર્યાસ્ત' },
      till: (n, t, next) => `${n} ${t} સુધી, પછી ${next}`,
    },
    kn: {
      label: 'ಕನ್ನಡ (Kannada)', locale: 'kn-IN', place: 'bengaluru',
      paksha: ['ಶುಕ್ಲ', 'ಕೃಷ್ಣ'],
      tithi: ['ಪಾಡ್ಯ', 'ಬಿದಿಗೆ', 'ತದಿಗೆ', 'ಚೌತಿ', 'ಪಂಚಮಿ', 'ಷಷ್ಠಿ', 'ಸಪ್ತಮಿ', 'ಅಷ್ಟಮಿ', 'ನವಮಿ', 'ದಶಮಿ', 'ಏಕಾದಶಿ', 'ದ್ವಾದಶಿ',
        'ತ್ರಯೋದಶಿ', 'ಚತುರ್ದಶಿ', 'ಹುಣ್ಣಿಮೆ', 'ಅಮಾವಾಸ್ಯೆ'],
      nakshatra: ['ಅಶ್ವಿನಿ', 'ಭರಣಿ', 'ಕೃತ್ತಿಕಾ', 'ರೋಹಿಣಿ', 'ಮೃಗಶಿರಾ', 'ಆರ್ದ್ರಾ', 'ಪುನರ್ವಸು', 'ಪುಷ್ಯ', 'ಆಶ್ಲೇಷಾ', 'ಮಘಾ',
        'ಪೂರ್ವ ಫಲ್ಗುಣಿ', 'ಉತ್ತರ ಫಲ್ಗುಣಿ', 'ಹಸ್ತ', 'ಚಿತ್ರಾ', 'ಸ್ವಾತಿ', 'ವಿಶಾಖಾ', 'ಅನುರಾಧಾ', 'ಜ್ಯೇಷ್ಠಾ', 'ಮೂಲಾ', 'ಪೂರ್ವಾಷಾಢಾ',
        'ಉತ್ತರಾಷಾಢಾ', 'ಶ್ರವಣ', 'ಧನಿಷ್ಠಾ', 'ಶತಭಿಷಾ', 'ಪೂರ್ವಾಭಾದ್ರಾ', 'ಉತ್ತರಾಭಾದ್ರಾ', 'ರೇವತಿ'],
      rasi: ['ಮೇಷ', 'ವೃಷಭ', 'ಮಿಥುನ', 'ಕರ್ಕಾಟಕ', 'ಸಿಂಹ', 'ಕನ್ಯಾ', 'ತುಲಾ', 'ವೃಶ್ಚಿಕ', 'ಧನು', 'ಮಕರ', 'ಕುಂಭ', 'ಮೀನ'],
      special: { pradosham: 'ಪ್ರದೋಷ', soma: 'ಸೋಮ ಪ್ರದೋಷ', shani: 'ಶನಿ ಪ್ರದೋಷ', ekadasi: 'ಏಕಾದಶಿ' },
      labels: { tithi: 'ತಿಥಿ', nakshatra: 'ನಕ್ಷತ್ರ', rasi: 'ರಾಶಿ', sunrise: 'ಸೂರ್ಯೋದಯ', sunset: 'ಸೂರ್ಯಾಸ್ತ' },
      till: (n, t, next) => `${n} ${t} ವರೆಗೆ, ನಂತರ ${next}`,
    },
    ml: {
      label: 'മലയാളം (Malayalam)', locale: 'ml-IN', place: 'trivandrum',
      paksha: ['ശുക്ലപക്ഷ', 'കൃഷ്ണപക്ഷ'],
      tithi: ['പ്രഥമ', 'ദ്വിതീയ', 'തൃതീയ', 'ചതുർത്ഥി', 'പഞ്ചമി', 'ഷഷ്ഠി', 'സപ്തമി', 'അഷ്ടമി', 'നവമി', 'ദശമി', 'ഏകാദശി',
        'ദ്വാദശി', 'ത്രയോദശി', 'ചതുർദശി', 'പൗർണ്ണമി', 'അമാവാസി'],
      nakshatra: ['അശ്വതി', 'ഭരണി', 'കാർത്തിക', 'രോഹിണി', 'മകയിരം', 'തിരുവാതിര', 'പുണർതം', 'പൂയം', 'ആയില്യം', 'മകം', 'പൂരം',
        'ഉത്രം', 'അത്തം', 'ചിത്തിര', 'ചോതി', 'വിശാഖം', 'അനിഴം', 'തൃക്കേട്ട', 'മൂലം', 'പൂരാടം', 'ഉത്രാടം', 'തിരുവോണം',
        'അവിട്ടം', 'ചതയം', 'പൂരുരുട്ടാതി', 'ഉത്രട്ടാതി', 'രേവതി'],
      rasi: ['മേടം', 'ഇടവം', 'മിഥുനം', 'കർക്കടകം', 'ചിങ്ങം', 'കന്നി', 'തുലാം', 'വൃശ്ചികം', 'ധനു', 'മകരം', 'കുംഭം', 'മീനം'],
      special: { pradosham: 'പ്രദോഷം', soma: 'സോമപ്രദോഷം', shani: 'ശനിപ്രദോഷം', ekadasi: 'ഏകാദശി' },
      labels: { tithi: 'തിഥി', nakshatra: 'നക്ഷത്രം', rasi: 'രാശി', sunrise: 'സൂര്യോദയം', sunset: 'സൂര്യാസ്തമയം' },
      till: (n, t, next) => `${n} ${t} വരെ, തുടർന്ന് ${next}`,
    },
  };

  const ORDER = ['en', 'ta-Latn', 'hi', 'bn', 'mr', 'te', 'ta', 'gu', 'kn', 'ml'];

  function lang(code) { return L[code] || L.en; }

  // tithi 1-30 -> "Shukla Dashami" / "Purnima" / "வளர்பிறை தசமி"
  function tithiName(code, t) {
    const x = lang(code);
    if (t === 15) return x.tithi[14];
    if (t === 30) return x.tithi[15];
    return `${x.paksha[t <= 15 ? 0 : 1]} ${x.tithi[(t - 1) % 15]}`;
  }

  function specialName(code, special) {
    if (!special) return null;
    const x = lang(code);
    if (special === 'purnima') return x.tithi[14];
    if (special === 'amavasya') return x.tithi[15];
    return x.special[special] || null;
  }

  // Latin digits everywhere, so times read the same in every script.
  function locale(code) { return `${lang(code).locale}-u-nu-latn`; }

  const api = { languages: L, order: ORDER, lang, tithiName, specialName, locale };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SRGPanchangI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
