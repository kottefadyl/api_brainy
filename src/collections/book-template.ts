import { FieldKind } from './collection.schema';
import type { BookRole } from './book-view.schema';

/** T47: the Book starter template. 17 data formats grouped from the classic parts of a book, leaving 7 free slots. */
type Field = { name: string; kind: FieldKind; options?: string[] };
export type BookTemplateFormat = { role: BookRole; name: string; color: string; single: boolean; parent?: BookRole; fields: Field[] };

export function bookTemplateFormats(fr: boolean): BookTemplateFormat[] {
  const title: Field = { name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE };
  const order: Field = { name: fr ? 'Ordre' : 'Order', kind: FieldKind.NUMBER };
  const text: Field = { name: fr ? 'Texte' : 'Text', kind: FieldKind.LONG_TEXT };
  const single = (role: BookRole, en: string, frName: string, color: string, fields: Field[] = [title, text]): BookTemplateFormat => ({ role, name: fr ? frName : en, color, single: true, fields });
  const many = (role: BookRole, en: string, frName: string, color: string, parent?: BookRole): BookTemplateFormat => ({ role, name: fr ? frName : en, color, single: false, parent, fields: [title, order, text] });
  return [
    single('COVER', 'Cover', 'Couverture', '#EEF5FF', [title, { name: fr ? 'Sous-titre' : 'Subtitle', kind: FieldKind.TEXT }, { name: fr ? 'Auteur' : 'Author', kind: FieldKind.TEXT }, { name: fr ? 'Image de couverture' : 'Cover image', kind: FieldKind.ATTACHMENT }, { name: fr ? 'Texte du dos' : 'Spine text', kind: FieldKind.TEXT }, { name: fr ? 'Quatrième de couverture' : 'Back cover', kind: FieldKind.LONG_TEXT }]),
    single('TITLE_PAGE', 'Title and copyright page', 'Page de titre et mentions légales', '#F1F5FA', [title, { name: fr ? 'Éditeur' : 'Publisher', kind: FieldKind.TEXT }, { name: fr ? 'Lieu et année' : 'Place and year', kind: FieldKind.TEXT }, { name: 'ISBN', kind: FieldKind.TEXT }, { name: fr ? 'Mentions légales' : 'Copyright notice', kind: FieldKind.LONG_TEXT }]),
    single('DEDICATION', 'Dedication', 'Dédicace', '#FFF0F4', [text]),
    single('EPIGRAPH', 'Epigraph', 'Épigraphe', '#F4F0FF', [{ name: fr ? 'Citation' : 'Quotation', kind: FieldKind.LONG_TEXT }, { name: fr ? 'Auteur de la citation' : 'Quoted author', kind: FieldKind.TEXT }]),
    single('FOREWORD', 'Foreword', 'Avant-propos', '#FBF7E9', [title, { name: fr ? 'Signé par' : 'Signed by', kind: FieldKind.TEXT }, text]),
    single('PREFACE', 'Preface', 'Préface', '#FFF5EB'),
    single('ACKNOWLEDGEMENTS', 'Acknowledgements', 'Remerciements', '#EDF9F3'),
    single('INTRODUCTION', 'Introduction', 'Introduction', '#EAF8FA'),
    many('PART', 'Part', 'Partie', '#EFEFFD'),
    many('CHAPTER', 'Chapter', 'Chapitre', '#EFF8FF', 'PART'),
    many('SECTION', 'Section', 'Section', '#F1F8ED', 'CHAPTER'),
    many('SUBSECTION', 'Subsection', 'Sous-section', '#F7FBEA', 'SECTION'),
    single('CONCLUSION', 'Conclusion', 'Conclusion', '#E9F8F4'),
    single('AFTERWORD', 'Afterword', 'Postface', '#FFF7F1'),
    many('APPENDIX', 'Appendix', 'Annexe', '#F8F0FA'),
    { role: 'TERM', name: fr ? 'Terme' : 'Term', color: '#FBF1E8', single: false, fields: [{ name: fr ? 'Terme' : 'Term', kind: FieldKind.TITLE }, { name: fr ? 'Définition' : 'Definition', kind: FieldKind.LONG_TEXT }, { name: fr ? 'Dans le glossaire' : 'In glossary', kind: FieldKind.BOOLEAN }, { name: fr ? 'Dans l’index' : 'In index', kind: FieldKind.BOOLEAN }] },
    { role: 'SOURCE', name: fr ? 'Source' : 'Source', color: '#F0F8F9', single: false, fields: [title, { name: fr ? 'Auteur' : 'Author', kind: FieldKind.TEXT }, { name: fr ? 'Année' : 'Year', kind: FieldKind.TEXT }, { name: fr ? 'Éditeur ou revue' : 'Publisher or journal', kind: FieldKind.TEXT }, { name: fr ? 'Lien' : 'Link', kind: FieldKind.LINK }, { name: fr ? 'Usage' : 'Use', kind: FieldKind.SELECT, options: fr ? ['Consultée', 'Citée'] : ['Consulted', 'Cited'] }] },
  ];
}
