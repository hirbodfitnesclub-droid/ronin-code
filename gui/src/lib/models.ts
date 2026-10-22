/* Ronin Code — helpers over the generated model catalog (lib/catalog). */
import { CATALOG, type CatalogModel } from './catalog';

export function modelById(id: string | null | undefined): CatalogModel | undefined {
  if (!id) return undefined;
  return CATALOG.find((m) => m.id === id);
}

/** Efforts the picker may offer: the catalog list minus 'upstream'. */
export function pickerEfforts(model: CatalogModel | undefined): string[] {
  if (!model || !Array.isArray(model.efforts)) return [];
  return model.efforts.filter((e) => e !== 'upstream');
}

/** Default effort for a model: 'medium' when offered, else the first. */
export function defaultEffort(model: CatalogModel | undefined): string | null {
  const list = pickerEfforts(model);
  if (list.length === 0) return null;
  return list.includes('medium') ? 'medium' : list[0];
}

export function hasFast(model: CatalogModel | undefined): boolean {
  return Boolean(model && model.fastCoeff !== null && model.fastCoeff !== undefined);
}

/** Group models by family, preserving catalog order within/across groups. */
export function groupByFamily(models: CatalogModel[]): Array<{ family: string; models: CatalogModel[] }> {
  const groups: Array<{ family: string; models: CatalogModel[] }> = [];
  for (const m of models) {
    const g = groups.find((x) => x.family === m.family);
    if (g) g.models.push(m);
    else groups.push({ family: m.family, models: [m] });
  }
  return groups;
}

/** Coefficient badge text: ×0.1, ×2.5, ×10. */
export function coeffLabel(coeff: number): string {
  return `×${coeff}`;
}
