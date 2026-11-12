import { BadRequestException } from '@nestjs/common';
import { Args, Context, Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthService } from '../auth/auth.service.js';
import { Collection, FieldKind, SensitivityLevel } from './collection.schema.js';
import { CollectionsService } from './collections.service.js';
import { StockService } from './stock.service.js';
import { TaskPlannerService, taskTemplateFields } from './task-planner.service.js';
import { bookTemplateFormats } from './book-template.js';
import { defaultBookView } from './book-view.schema.js';

@ObjectType()
class StarterTemplate {
  @Field() id!: string;
  @Field() name!: string;
  @Field() description!: string;
}

type Request = { headers: { authorization?: string } };
type TemplateField = { name: string; kind: FieldKind; options?: string[]; unit?: string };
type TemplateFormat = { name: string; color: string; fields: TemplateField[]; objectModel?: boolean; sensitivity?: SensitivityLevel };
type TemplateDefinition = { id: string; name: string; description: string; formats: TemplateFormat[]; layout?: 'TASKS' | 'CALENDAR' };

function templates(language: string): TemplateDefinition[] {
  const fr = language === 'fr';
  return [
    { id: 'blank', name: fr ? 'Partir de zéro' : 'Start from scratch', description: fr ? 'Une collection et un format de données simple à modifier.' : 'One simple, editable data format.', formats: [{ name: fr ? 'Général' : 'General', color: '#EEF5FF', fields: [{ name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE }] }] },
    { id: 'kt_personal', name: 'KT personal', description: fr ? 'Ventes d’eau : notez le montant de chaque journée et suivez le total de la semaine, du mois et de l’année.' : 'Water sales: note each day’s amount and follow the week, month and year totals.', formats: [{ name: fr ? 'Bilan du jour' : 'Daily sales', color: '#EAF8FA', fields: [{ name: 'Date', kind: FieldKind.DATE }, { name: fr ? 'Montant' : 'Amount', kind: FieldKind.NUMBER, unit: 'FCFA' }] }] },
    { id: 'notes', name: fr ? 'Notes et écriture' : 'Notes and writing', description: fr ? 'Des notes longues, datées et faciles à rechercher.' : 'Dated, searchable long-form notes.', formats: [{ name: fr ? 'Note' : 'Note', color: '#EEF5FF', fields: [{ name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE }, { name: fr ? 'Contenu' : 'Content', kind: FieldKind.LONG_TEXT }, { name: fr ? 'Date' : 'Date', kind: FieldKind.DATE }] }] },
    { id: 'links', name: fr ? 'Liens conservés' : 'Saved links', description: fr ? 'URL, commentaire, catégorie et date de sauvegarde.' : 'URL, comment, category and saved date.', formats: [{ name: fr ? 'Lien' : 'Link', color: '#EDF9F3', fields: [{ name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE }, { name: 'URL', kind: FieldKind.LINK }, { name: fr ? 'Commentaire' : 'Comment', kind: FieldKind.LONG_TEXT }, { name: fr ? 'Catégorie' : 'Category', kind: FieldKind.TEXT }, { name: fr ? 'Enregistré le' : 'Saved on', kind: FieldKind.DATE }] }] },
    { id: 'capture', name: fr ? 'Captures rapides' : 'Quick captures', description: fr ? 'Liens, textes et fichiers avec une note de contexte.' : 'Links, text and files with a context note.', formats: [{ name: fr ? 'Capture' : 'Capture', color: '#EAF8FA', fields: [{ name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE }, { name: fr ? 'Lien' : 'Link', kind: FieldKind.LINK }, { name: fr ? 'Texte' : 'Text', kind: FieldKind.TEXT }, { name: fr ? 'Note' : 'Note', kind: FieldKind.LONG_TEXT }, { name: fr ? 'Source' : 'Source', kind: FieldKind.TEXT }, { name: fr ? 'Pièce jointe' : 'Attachment', kind: FieldKind.ATTACHMENT }] }] },
    { id: 'tasks', name: fr ? 'Liste de tâches' : 'Task list', description: fr ? 'Tâches uniques ou qui reviennent, avec une vue du jour et un calendrier.' : 'One-off or repeating tasks, with a day view and a calendar.', formats: [{ name: fr ? 'Tâche' : 'Task', color: '#FFF5EB', fields: taskTemplateFields(fr) }], layout: 'TASKS' },
    { id: 'agenda', name: fr ? 'Agenda' : 'Calendar', description: fr ? 'Rendez-vous avec début, fin et lieu.' : 'Events with start, end and place.', formats: [{ name: fr ? 'Rendez-vous' : 'Event', color: '#F4F0FF', fields: [{ name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE }, { name: fr ? 'Début' : 'Start', kind: FieldKind.DATETIME }, { name: fr ? 'Fin' : 'End', kind: FieldKind.DATETIME }, { name: fr ? 'Lieu' : 'Place', kind: FieldKind.TEXT }] }], layout: 'CALENDAR' },
    { id: 'expenses', name: fr ? 'Dépenses' : 'Expenses', description: fr ? 'Montant, catégorie et date ; analyses disponibles ensuite.' : 'Amount, category and date, ready for analysis.', formats: [{ name: fr ? 'Dépense' : 'Expense', color: '#FFF0F4', fields: [{ name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE }, { name: fr ? 'Montant' : 'Amount', kind: FieldKind.NUMBER }, { name: fr ? 'Catégorie' : 'Category', kind: FieldKind.TEXT }, { name: fr ? 'Date' : 'Date', kind: FieldKind.DATE }, { name: fr ? 'Note' : 'Note', kind: FieldKind.LONG_TEXT }] }] },
    { id: 'shop', name: fr ? 'Commerce et stock' : 'Shop and stock', description: fr ? 'Produits, fournisseurs et mouvements avec validation explicite.' : 'Products, suppliers and explicitly confirmed stock movements.', formats: [
      { name: fr ? 'Produit' : 'Product', color: '#EDF9F3', objectModel: true, fields: [{ name: fr ? 'Nom' : 'Name', kind: FieldKind.TITLE }, { name: 'SKU', kind: FieldKind.TEXT }, { name: fr ? 'Catégorie' : 'Category', kind: FieldKind.TEXT }] },
      { name: fr ? 'Fournisseur' : 'Supplier', color: '#EEF5FF', objectModel: true, fields: [{ name: fr ? 'Nom' : 'Name', kind: FieldKind.TITLE }, { name: fr ? 'Contact' : 'Contact', kind: FieldKind.TEXT }] },
    ] },
    ...([
      ['science', fr ? 'Mesures scientifiques' : 'Scientific measurements', fr ? 'Échantillon' : 'Sample', '#EEF5FF'],
      ['weather', fr ? 'Observations météo' : 'Weather observations', fr ? 'Lieu' : 'Location', '#EDF9F3'],
      ['health', fr ? 'Suivi personnel de santé' : 'Personal health tracking', fr ? 'Sujet' : 'Subject', '#FFF0F4'],
      ['machine', fr ? 'Mesures de machines' : 'Machine measurements', fr ? 'Machine' : 'Machine', '#FFF5EB'],
    ] as const).map(([id, name, subject, color]) => ({ id, name, description: fr ? 'Mesures datées avec qualité, conditions et source.' : 'Dated measurements with quality, conditions and source.', formats: [{ name: subject, color, objectModel: true, sensitivity: id === 'health' ? SensitivityLevel.SENSITIVE : SensitivityLevel.ORDINARY, fields: [{ name: fr ? 'Nom' : 'Name', kind: FieldKind.TITLE }] }] })),
        { id: 'fitness', name: fr ? 'Entraînement et sport' : 'Fitness and workouts', description: fr ? 'Exercices, séances, séries, charges et calendrier d’entraînement.' : 'Exercises, workouts, sets, weights and training calendar.', formats: [
      { name: fr ? 'Exercice' : 'Exercise', color: '#EEF5FF', objectModel: true, fields: [
        { name: fr ? 'Nom' : 'Name', kind: FieldKind.TITLE },
        { name: fr ? 'Groupe musculaire' : 'Muscle group', kind: FieldKind.SELECT, options: fr ? ['Pectoraux', 'Dos', 'Jambes', 'Épaules', 'Bras', 'Abdominaux', 'Cardio', 'Corps complet'] : ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Abs', 'Cardio', 'Full body'] },
        { name: fr ? 'Équipement' : 'Equipment', kind: FieldKind.SELECT, options: fr ? ['Haltères', 'Barre', 'Machine', 'Poids du corps', 'Autre'] : ['Dumbbell', 'Barbell', 'Machine', 'Bodyweight', 'Other'] },
        { name: fr ? 'Consignes' : 'Instructions', kind: FieldKind.LONG_TEXT },
      ] },
      { name: fr ? 'Séance' : 'Workout', color: '#EDF9F3', fields: [
        { name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE },
        { name: fr ? 'Début' : 'Start', kind: FieldKind.DATETIME },
        { name: fr ? 'Fin' : 'End', kind: FieldKind.DATETIME },
        { name: fr ? 'Durée' : 'Duration', kind: FieldKind.DURATION },
        { name: fr ? 'Type de séance' : 'Workout type', kind: FieldKind.SELECT, options: fr ? ['Musculation', 'Cardio / Course', 'HIIT', 'Étirements', 'Autre'] : ['Strength', 'Cardio / Run', 'HIIT', 'Stretching', 'Other'] },
        { name: fr ? 'Difficulté (RPE 1-10)' : 'RPE (1-10)', kind: FieldKind.NUMBER },
        { name: fr ? 'Notes' : 'Notes', kind: FieldKind.LONG_TEXT },
      ] },
    ] },
    { id: 'book', name: fr ? 'Livre' : 'Book', description: fr ? 'Couverture, pages liminaires, parties, chapitres, sections et pages finales, avec une vue livre à mettre en page.' : 'Cover, front matter, parts, chapters, sections and back matter, with a book view to lay out.', formats: bookTemplateFormats(fr).map(({ name, color, fields }) => ({ name, color, fields })) },
  ];
}

@Resolver()
export class StarterTemplateResolver {
  constructor(private readonly collections: CollectionsService, private readonly auth: AuthService, private readonly stock: StockService, private readonly planner: TaskPlannerService, @InjectModel(Collection.name) private readonly collectionModel: Model<Collection>) {}

  @Query(() => [StarterTemplate])
  starterTemplates(@Args('language', { type: () => String, nullable: true }) language?: string): StarterTemplate[] {
    return templates(language ?? 'en').map(({ id, name, description }) => ({ id, name, description }));
  }

  @Mutation(() => Collection)
  async createCollectionFromTemplate(@Args('templateId') templateId: string, @Args('name') name: string, @Args('language', { type: () => String, nullable: true }) language: string | undefined, @Args('timeZone', { type: () => String, nullable: true }) timeZone: string | undefined, @Context('req') request: Request): Promise<Collection> {
    const ownerId = (await this.auth.currentUser(request.headers.authorization)).id;
    const template = templates(language ?? 'en').find((item) => item.id === templateId);
    if (!template) throw new BadRequestException('Unknown template');
    let collection = await this.collections.create({ name, formats: template.formats }, ownerId);
    // T47/T48: keep the starting template as provenance only (never a permanent collection type).
    collection = (await this.collectionModel.findOneAndUpdate({ _id: collection.id, ownerId }, { $set: { templateId: template.id } }, { returnDocument: 'after' }).exec())!;
    const format = collection.formats[0];
    const byKind = (kind: FieldKind) => format.fields.find((field) => field.kind === kind)?.id;
    if (template.layout === 'TASKS') {
      const dates = format.fields.filter((field) => field.kind === FieldKind.DATE);
      collection = await this.collections.saveView(collection.id, ownerId, { name: language === 'fr' ? 'À faire' : 'To do', layout: 'TASKS', formatIds: [format.id], columnFieldIds: format.fields.map((field) => field.id), sort: 'NEWEST', groupByFormat: false, taskDoneFieldId: byKind(FieldKind.BOOLEAN), taskDueFieldId: (dates[1] ?? dates[0])?.id, taskCompletedFieldId: byKind(FieldKind.DATETIME) });
      if (template.id === 'tasks') collection = await this.planner.setUp(collection.id, format.id, ownerId, language);
    }
    if (template.layout === 'CALENDAR') {
      const dates = format.fields.filter((field) => field.kind === FieldKind.DATETIME);
      collection = await this.collections.saveView(collection.id, ownerId, { name: language === 'fr' ? 'Calendrier' : 'Calendar', layout: 'CALENDAR', formatIds: [format.id], columnFieldIds: format.fields.map((field) => field.id), sort: 'NEWEST', groupByFormat: false, calendarStartFieldId: dates[0].id, calendarEndFieldId: dates[1].id, calendarTimeZone: timeZone || 'UTC' });
    }
    if (template.id === 'kt_personal') {
      const periodTotals = { formatId: format.id, dateFieldId: byKind(FieldKind.DATE), amountFieldId: byKind(FieldKind.NUMBER) };
      collection = (await this.collectionModel.findOneAndUpdate({ _id: collection.id, ownerId }, { $set: { periodTotals } }, { returnDocument: 'after' }).exec())!;
    }
    if (template.id === 'book') {
      const definitions = bookTemplateFormats(language === 'fr');
      const idOf = (role: string) => collection.formats[definitions.findIndex((item) => item.role === role)].id;
      const formats = collection.formats.map((format, index) => ({ ...(format as unknown as { toObject?: () => object }).toObject?.() ?? format, singleEntry: definitions[index].single, parentFormatIds: definitions[index].parent ? [idOf(definitions[index].parent!)] : undefined }));
      const roles = definitions.map((item, index) => ({ formatId: collection.formats[index].id, role: item.role }));
      collection = (await this.collectionModel.findOneAndUpdate({ _id: collection.id, ownerId }, { $set: { formats, templateId: 'book', bookView: defaultBookView(roles) } }, { returnDocument: 'after' }).exec())!;
      const ordered = collection.formats.filter((item) => item.fields.some((field) => field.kind === FieldKind.NUMBER));
      collection = await this.collections.saveView(collection.id, ownerId, { name: language === 'fr' ? 'Manuscrit' : 'Manuscript', layout: 'LIST', formatIds: ordered.map((item) => item.id), columnFieldIds: ordered.flatMap((item) => item.fields.filter((field) => [FieldKind.TITLE, FieldKind.NUMBER].includes(field.kind)).map((field) => field.id)), sort: 'MANUAL', manualOrderFieldIds: ordered.map((item) => item.fields.find((field) => field.kind === FieldKind.NUMBER)!.id), groupByFormat: false });
    }
    if (template.id === 'shop') {
      const productId = collection.formats[0].id;
      const add = async (kind: 'IN' | 'OUT' | 'TRANSFER', label: string, color: string): Promise<void> => {
        const fields = [
          { name: language === 'fr' ? 'Titre' : 'Title', kind: FieldKind.TITLE },
          { name: language === 'fr' ? 'Produit' : 'Product', kind: FieldKind.OBJECT_REF, targetObjectFormatId: productId },
          { name: language === 'fr' ? 'Quantité' : 'Quantity', kind: FieldKind.NUMBER, unit: 'item' },
          { name: language === 'fr' ? 'Date du fait' : 'Occurred at', kind: FieldKind.DATETIME },
          { name: language === 'fr' ? 'Lieu source' : 'From location', kind: FieldKind.TEXT },
          { name: language === 'fr' ? 'Lieu destination' : 'To location', kind: FieldKind.TEXT },
          { name: language === 'fr' ? 'Lot' : 'Lot', kind: FieldKind.TEXT },
          { name: language === 'fr' ? 'Motif' : 'Reason', kind: FieldKind.TEXT },
        ];
        collection = await this.collections.addFormat(collection.id, { name: label, color, fields }, ownerId);
        const created = collection.formats.at(-1)!;
        const fieldId = (index: number) => created.fields[index].id;
        collection = await this.stock.saveRule(collection.id, ownerId, { name: label, formatId: created.id, productFieldId: fieldId(1), quantityFieldId: fieldId(2), kind, dateFieldId: fieldId(3), fromLocationFieldId: fieldId(4), toLocationFieldId: fieldId(5), lotFieldId: fieldId(6), reasonFieldId: fieldId(7) });
      };
      await add('IN', language === 'fr' ? 'Réception de stock' : 'Stock receipt', '#FFF5EB');
      await add('OUT', language === 'fr' ? 'Vente ou sortie' : 'Sale or outgoing', '#FFF0F4');
      await add('TRANSFER', language === 'fr' ? 'Transfert de stock' : 'Stock transfer', '#F4F0FF');
    }
        if (template.id === 'fitness') {
      const exerciseFormatId = collection.formats[0].id;
      const workoutFormat = collection.formats[1];
      const dates = workoutFormat.fields.filter((field) => field.kind === FieldKind.DATETIME);
      collection = await this.collections.addFormat(collection.id, {
        name: language === 'fr' ? 'Série' : 'Set',
        color: '#FFF0F4',
        fields: [
          { name: language === 'fr' ? 'Titre' : 'Title', kind: FieldKind.TITLE },
          { name: language === 'fr' ? 'Exercice' : 'Exercise', kind: FieldKind.OBJECT_REF, targetObjectFormatId: exerciseFormatId },
          { name: language === 'fr' ? 'Charge' : 'Weight', kind: FieldKind.NUMBER, unit: 'kg' },
          { name: language === 'fr' ? 'Répétitions' : 'Reps', kind: FieldKind.NUMBER },
          { name: language === 'fr' ? 'Récupération' : 'Rest', kind: FieldKind.DURATION },
          { name: language === 'fr' ? 'Date' : 'Date', kind: FieldKind.DATETIME },
          { name: language === 'fr' ? 'Commentaire' : 'Comment', kind: FieldKind.TEXT },
        ],
      }, ownerId);
      const setFormat = collection.formats.at(-1)!;
      if (dates.length >= 2) {
        collection = await this.collections.saveView(collection.id, ownerId, {
          name: language === 'fr' ? 'Calendrier des séances' : 'Workout calendar',
          layout: 'CALENDAR',
          formatIds: [workoutFormat.id],
          columnFieldIds: workoutFormat.fields.map((field) => field.id),
          sort: 'NEWEST',
          groupByFormat: false,
          calendarStartFieldId: dates[0].id,
          calendarEndFieldId: dates[1].id,
          calendarTimeZone: timeZone || 'UTC',
        });
      }
      collection = await this.collections.saveView(collection.id, ownerId, {
        name: language === 'fr' ? 'Journal des séries' : 'Sets log',
        layout: 'TABLE',
        formatIds: [setFormat.id],
        columnFieldIds: setFormat.fields.map((field) => field.id),
        sort: 'NEWEST',
        groupByFormat: false,
      });
    }
    if (['science', 'weather', 'health', 'machine'].includes(template.id)) {
      const unit = template.id === 'weather' ? '°C' : template.id === 'health' ? 'bpm' : template.id === 'machine' ? 'h' : 'g';
      const subjectId = collection.formats[0].id;
      collection = await this.collections.addFormat(collection.id, {
        name: language === 'fr' ? 'Mesure' : 'Measurement', color: '#F4F0FF', sensitivity: template.id === 'health' ? SensitivityLevel.SENSITIVE : SensitivityLevel.ORDINARY, fields: [
          { name: language === 'fr' ? 'Titre' : 'Title', kind: FieldKind.TITLE },
          { name: language === 'fr' ? 'Objet mesuré' : 'Measured subject', kind: FieldKind.OBJECT_REF, targetObjectFormatId: subjectId },
          { name: language === 'fr' ? 'Valeur' : 'Value', kind: FieldKind.NUMBER, unit },
          { name: language === 'fr' ? 'Date du fait' : 'Occurred at', kind: FieldKind.DATETIME },
          { name: language === 'fr' ? 'Conditions' : 'Conditions', kind: FieldKind.TEXT },
          { name: language === 'fr' ? 'Qualité' : 'Quality', kind: FieldKind.SELECT, options: language === 'fr' ? ['Bonne', 'Incertaine', 'À vérifier'] : ['Good', 'Uncertain', 'Review'] },
          { name: language === 'fr' ? 'Source' : 'Source', kind: FieldKind.TEXT },
        ],
      }, ownerId);
      const measured = collection.formats.at(-1)!;
      collection = await this.collections.saveView(collection.id, ownerId, { name: language === 'fr' ? 'Tableau des mesures' : 'Measurement dashboard', layout: 'TABLE', formatIds: [measured.id], columnFieldIds: measured.fields.filter((field) => field.kind !== FieldKind.LONG_TEXT).map((field) => field.id), sort: 'NEWEST', groupByFormat: false });
    }
    return collection;
  }
}
