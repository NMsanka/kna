/**
 * Billing domain types and the service that owns invoice lifecycle.
 *
 * Deliberately shaped like real code: overloads, generics, inheritance, JSDoc with `@param`
 * and `@throws`, a deprecated member, and a private helper. The conformance suite reads this
 * file, so changing it changes what "correct IR" means.
 */

/** A currency amount in minor units, to avoid float arithmetic on money. */
export interface Money {
  /** Amount in the smallest unit of the currency (cents, pence, sen). */
  amountMinor: number;
  /** ISO 4217 code. */
  currency: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: Money;
}

export enum InvoiceStatus {
  Draft = 'draft',
  Issued = 'issued',
  Paid = 'paid',
  Void = 'void',
}

export type InvoiceId = string & { readonly __brand: 'InvoiceId' };

export interface Invoice {
  id: InvoiceId;
  customerId: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  total: Money;
  issuedAt: Date | null;
}

export class InvoiceNotFoundError extends Error {
  constructor(readonly invoiceId: InvoiceId) {
    super(`Invoice ${invoiceId} not found`);
    this.name = 'InvoiceNotFoundError';
  }
}

export interface InvoiceRepository {
  findById(id: InvoiceId): Promise<Invoice | null>;
  save(invoice: Invoice): Promise<void>;
}

/**
 * Creates, issues and voids invoices.
 *
 * Every mutation goes through this class so the status transitions stay in one place.
 */
export class InvoiceService {
  private readonly cache = new Map<string, Invoice>();

  constructor(private readonly repository: InvoiceRepository) {}

  /**
   * Create a draft invoice for a customer.
   *
   * @param customerId Identifier of the customer being billed.
   * @param lines      Line items; must contain at least one entry.
   * @returns The created invoice, in `Draft` status.
   * @throws {RangeError} When `lines` is empty.
   */
  async create(customerId: string, lines: InvoiceLine[]): Promise<Invoice> {
    if (lines.length === 0) {
      throw new RangeError('An invoice needs at least one line');
    }

    const invoice: Invoice = {
      id: crypto.randomUUID() as InvoiceId,
      customerId,
      status: InvoiceStatus.Draft,
      lines,
      total: this.computeTotal(lines),
      issuedAt: null,
    };

    await this.repository.save(invoice);
    this.cache.set(invoice.id, invoice);
    return invoice;
  }

  /**
   * Transition a draft invoice to `Issued`.
   *
   * @param id The invoice to issue.
   * @throws {InvoiceNotFoundError} When no invoice with that id exists.
   */
  async issue(id: InvoiceId): Promise<Invoice> {
    const invoice = await this.repository.findById(id);
    if (!invoice) throw new InvoiceNotFoundError(id);

    invoice.status = InvoiceStatus.Issued;
    invoice.issuedAt = new Date();
    await this.repository.save(invoice);
    return invoice;
  }

  /** @deprecated Use `issue` instead; this ignores the status machine entirely. */
  async forceIssue(id: InvoiceId): Promise<void> {
    const invoice = await this.repository.findById(id);
    if (invoice) {
      invoice.status = InvoiceStatus.Issued;
      await this.repository.save(invoice);
    }
  }

  private computeTotal(lines: InvoiceLine[]): Money {
    const amountMinor = lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPrice.amountMinor,
      0,
    );
    return { amountMinor, currency: lines[0]?.unitPrice.currency ?? 'USD' };
  }
}

/**
 * Format an amount for display.
 *
 * @param money  The amount to format.
 * @param locale BCP 47 locale tag.
 */
export function formatMoney(money: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency }).format(
    money.amountMinor / 100,
  );
}

/** Non-exported helper — should be visible as `internal`, not `public`. */
function unusedHelper(value: number): number {
  return value * 2;
}

export const DEFAULT_CURRENCY = 'USD';

export const summariseInvoice = (invoice: Invoice): string =>
  `${invoice.id}: ${formatMoney(invoice.total)} (${invoice.status})`;

void unusedHelper;
