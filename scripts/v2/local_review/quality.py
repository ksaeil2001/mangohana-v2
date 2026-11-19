"""Mechanical checks before an OCR/translation result may replace source lettering."""
import re
import unicodedata

JAPANESE=re.compile(r'[\u3041-\u3096\u30a1-\u30fa\u3400-\u9fff]')
HANGUL=re.compile(r'[가-힣ㄱ-ㅎㅏ-ㅣᄀ-ᇿ]')
RUN=re.compile(r'(.{1,10}?)\1{5,}',re.DOTALL)
REQUEST_END=re.compile(r'(?:って|いて|いで|んで|して|ないで|[けげせぜてでねへべめれえみきぎびじり見来]て)(?:ね|よ)?$')
SENTENCE_END='。．.!！?？…〜～「」『』“” '
KINSHIP_ARGUMENT=re.compile(r'(?<![\u3400-\u9fff々])([兄姉弟妹])(が|は|に)')
KINSHIP={'兄':('손위 남자 형제','형 오빠 형님 오라버니'), '姉':('손위 여자 형제','언니 누나 누님'),
         '弟':('손아래 남자 형제','남동생 동생 아우'), '妹':('손아래 여자 형제','여동생 동생 누이')}
KOREAN_KIN=re.compile(r'(?<![가-힣])(형님|형|오빠|오라버니|언니|누나|누님|남동생|여동생|동생|아우|누이|아내|남편)(에게|한테|께|은|는|이|가)(?=\s|$)')
MORAU=re.compile(r'(?:て|で)(?:もら|貰|いただ|頂)')
ACTOR_TERMS={'先生':('선생님','선생','교사','스승'), '友達':('친구',), '母':('어머니','엄마'), '父':('아버지','아빠')}


def kinship_argument(source):
    # Only a single, explicit argument. Exclude compounds, proper names and mixed relatives.
    if len(re.findall('[兄姉弟妹]',source))!=1 or re.search(r'[。！？!?]',source.strip().rstrip(SENTENCE_END)):
        return None
    match=KINSHIP_ARGUMENT.search(source)
    return (match[2],*KINSHIP[match[1]]) if match else None


def reversed_benefactive(source,target):
    if not MORAU.search(source) or re.search(r'달라|부탁|받았|받아|에게서|한테서',target):
        return False
    if not re.search(r'(?:줘|줬|주었|드렸|드렸다)',target):
        return False
    for actor,names in ACTOR_TERMS.items():
        if re.search(r'(?<![一-龯々])'+actor+'(?:に|から)',source):
            return any(re.search(r'(?<![가-힣])'+name+r'(?:에게|한테|께)(?=\s)',target) for name in names)
    return False


def speech_form(source):
    clause=source.strip().rstrip(SENTENCE_END)
    if re.search(r'[。！？!?]',clause):
        return ''
    if re.search(r'(?:て|で)(?:ください|下さい|いただけますか)(?:ね|よ)?$',clause):
        return '상대에게 하는 부탁 · 존댓말'
    if REQUEST_END.search(clause):
        return '상대에게 하는 부탁 · 반말'
    if re.search(r'(?:です|ます|ました|ません)(?:ね|よ)?$',clause):
        return '존댓말 진술'
    if re.search(r'(?:だ|だよ|だね|よ)$',clause):
        return '반말 진술'
    return ''


def ends_in_promise(target):
    # Korean -ㄹ게(요) expresses the speaker's intention, including forms like 드릴게요.
    match=re.search(r'([가-힣])게(?:요)?$',target.strip().rstrip(SENTENCE_END))
    return bool(match and (ord(match[1])-ord('가'))%28==8)


def review_flags(source,target,ended):
    flags=[]
    if not target.strip():
        flags.append('NO_TARGET_TEXT')
    if not ended:
        flags.append('TOKEN_LIMIT')
    if JAPANESE.search(target):
        flags.append('JAPANESE_REMAINS')
    if JAPANESE.search(source) and target.strip() and not HANGUL.search(target):
        flags.append('NO_HANGUL')
    if source.strip() and not any(c.isalnum() for c in source) and any(c.isalnum() for c in target):
        flags.append('PUNCTUATION_EXPANDED')
    if speech_form(source).startswith('상대에게 하는 부탁') and ends_in_promise(target):
        flags.append('REQUEST_BECAME_PROMISE')
    kin=kinship_argument(source)
    if kin:
        recipient=kin[0]=='に'
        names=[name for name,particle in KOREAN_KIN.findall(target) if recipient==(particle in ('에게','한테','께'))]
        if len(names)==1 and names[0] not in kin[2].split():
            flags.append('KINSHIP_RECIPIENT_CONFLICT' if recipient else 'KINSHIP_SUBJECT_CONFLICT')
    if reversed_benefactive(source,target):
        flags.append('BENEFACTIVE_ACTOR_REVERSED')
    if re.search(r'[가-힣][이가]\s+않(?:아|았|으|다|습|는|네|고)',target):
        flags.append('MALFORMED_KOREAN_NEGATION')
    compact=lambda value: ''.join(unicodedata.normalize('NFKC',value).split())
    clean=compact(target)
    original=compact(source)
    if len(clean)>=max(18,len(original)*2) and any(
            len(run[0])>=max(15,len(clean)*.55) for run in RUN.finditer(clean)):
        flags.append('REPETITIVE_OUTPUT')
    return flags
