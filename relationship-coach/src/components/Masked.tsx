const TOKEN = /(\[(?:주민번호|카드번호|전화번호|계좌번호|이메일|링크|주소|이름|가림)\])/g;

/** 가림 표시를 눈에 띄게 보여 준다. */
export default function Masked({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="mask">{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}
