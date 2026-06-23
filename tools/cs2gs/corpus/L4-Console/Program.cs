// L4-Console: the fourth corpus level. A deterministic warehouse-ledger program
// whose stdout is the parity oracle (no timestamps / random / GUIDs / culture).
//
// It exercises C# surface area that L1-L3 do not, each a candidate gap source
// for the C#->G# migration (ADR-0115 section B / G):
//
//   * Exception handling: try / typed catch / finally, throw new, a custom
//     exception type chaining to base(message), re-throw, and reading
//     ex.Message.
//   * Dictionary<string,int> + HashSet<string>: add / indexer lookup /
//     pre-declared TryGetValue out / deterministic (sorted) iteration /
//     Contains / Count.
//   * using statement and IDisposable: an AuditLog whose Dispose() prints,
//     driven by both a `using (...)` block and a C# 8 `using var` declaration.
//   * Nullable value types: int? with .HasValue / .Value, null-coalescing ??,
//     and a null check.
//   * Operator overloading on a value type: a struct with operator +, *,
//     == / != and the matching Equals(Money) / GetHashCode.
//
// Ordinary, idiomatic C# (underscore private fields, no StyleCop header,
// implicit `this`) - the migration *input*, not product code.
using System;
using System.Collections.Generic;

namespace Corpus.L4
{
    // A custom exception type derived from System.Exception.
    internal sealed class InsufficientStockException : Exception
    {
        public InsufficientStockException(string sku, string message)
            : base(message)
        {
            Sku = sku;
        }

        public string Sku;
    }

    // Operator overloading on a value type (money in whole cents).
    internal struct Money
    {
        public int Cents;

        public Money(int cents)
        {
            Cents = cents;
        }

        public static Money operator +(Money a, Money b)
        {
            return new Money(a.Cents + b.Cents);
        }

        public static Money operator *(Money a, int factor)
        {
            return new Money(a.Cents * factor);
        }

        public static bool operator ==(Money a, Money b)
        {
            return a.Cents == b.Cents;
        }

        public static bool operator !=(Money a, Money b)
        {
            return a.Cents != b.Cents;
        }

        public bool Equals(Money other)
        {
            return Cents == other.Cents;
        }

        public override int GetHashCode()
        {
            return Cents;
        }

        public string Format()
        {
            int dollars = Cents / 100;
            int cents = Cents % 100;
            return $"${dollars}.{cents:D2}";
        }
    }

    // An IDisposable resource whose Dispose() prints, for deterministic
    // dispose-ordering observation.
    internal sealed class AuditLog : IDisposable
    {
        private readonly string _name;

        public AuditLog(string name)
        {
            _name = name;
            Console.WriteLine($"[audit] open {_name}");
        }

        public void Record(string entry)
        {
            Console.WriteLine($"[audit] {_name}: {entry}");
        }

        public void Dispose()
        {
            Console.WriteLine($"[audit] close {_name}");
        }
    }

    internal sealed class Warehouse
    {
        private readonly Dictionary<string, int> _stock;
        private readonly HashSet<string> _categories;

        public Warehouse()
        {
            _stock = new Dictionary<string, int>();
            _categories = new HashSet<string>();
        }

        public int CategoryCount => _categories.Count;

        public void Stock(string sku, int quantity, string category)
        {
            int existing;
            if (_stock.TryGetValue(sku, out existing))
            {
                _stock[sku] = existing + quantity;
            }
            else
            {
                _stock[sku] = quantity;
            }

            _categories.Add(category);
        }

        public void Remove(string sku, int quantity)
        {
            int qty;
            int available = _stock.TryGetValue(sku, out qty) ? qty : 0;
            if (quantity > available)
            {
                throw new InsufficientStockException(
                    sku,
                    $"cannot remove {quantity} of '{sku}': only {available} in stock");
            }

            _stock[sku] = available - quantity;
        }

        public int CountOf(string sku)
        {
            int qty;
            bool found = _stock.TryGetValue(sku, out qty);
            return found ? qty : 0;
        }

        public bool HasCategory(string category)
        {
            return _categories.Contains(category);
        }

        public void PrintStock()
        {
            var keys = new List<string>(_stock.Keys);
            keys.Sort();
            foreach (var sku in keys)
            {
                Console.WriteLine($"  {sku} = {_stock[sku]}");
            }
        }
    }

    internal static class Program
    {
        private static void Main()
        {
            var warehouse = new Warehouse();
            warehouse.Stock("apple", 10, "fruit");
            warehouse.Stock("banana", 6, "fruit");
            warehouse.Stock("wrench", 3, "tool");
            warehouse.Stock("apple", 5, "fruit");

            Console.WriteLine("Stock levels:");
            warehouse.PrintStock();
            Console.WriteLine($"Categories tracked: {warehouse.CategoryCount}");
            Console.WriteLine($"Has 'tool' category: {warehouse.HasCategory("tool")}");
            Console.WriteLine($"Has 'spice' category: {warehouse.HasCategory("spice")}");

            Console.WriteLine();
            RunLedger(warehouse);

            Console.WriteLine();
            RunMoney();

            Console.WriteLine();
            RunNullable(warehouse);

            Console.WriteLine();
            RunReconcile(warehouse);
        }

        private static void RunReconcile(Warehouse warehouse)
        {
            try
            {
                Audit(warehouse, "banana", 99);
            }
            catch (InsufficientStockException ex)
            {
                Console.WriteLine($"Reconcile failed for {ex.Sku}: {ex.Message}");
            }
        }

        private static void Audit(Warehouse warehouse, string sku, int quantity)
        {
            try
            {
                warehouse.Remove(sku, quantity);
            }
            catch (InsufficientStockException ex)
            {
                Console.WriteLine($"Audit rethrow ({ex.Sku})");
                throw;
            }
        }

        private static void RunLedger(Warehouse warehouse)
        {
            using (var log = new AuditLog("ledger"))
            {
                log.Record("start");
                TryRemove(warehouse, "apple", 4, log);
                TryRemove(warehouse, "wrench", 9, log);
                log.Record("end");
            }

            using var summary = new AuditLog("summary");
            summary.Record($"apples remaining: {warehouse.CountOf("apple")}");
        }

        private static void TryRemove(Warehouse warehouse, string sku, int quantity, AuditLog log)
        {
            try
            {
                warehouse.Remove(sku, quantity);
                log.Record($"removed {quantity} {sku}");
            }
            catch (InsufficientStockException ex)
            {
                Console.WriteLine($"Rejected: {ex.Message}");
                log.Record($"rejected {sku}");
            }
            finally
            {
                log.Record($"done {sku}");
            }
        }

        private static void RunMoney()
        {
            var unit = new Money(250);
            var three = unit * 3;
            var bundle = three + new Money(99);

            Console.WriteLine($"Unit price: {unit.Format()}");
            Console.WriteLine($"Three units: {three.Format()}");
            Console.WriteLine($"Bundle: {bundle.Format()}");
            Console.WriteLine($"three == bundle: {three == bundle}");
            Console.WriteLine($"three != bundle: {three != bundle}");
            Console.WriteLine($"unit*3 == three: {unit * 3 == three}");
            Console.WriteLine($"Equal via Equals: {three.Equals(unit * 3)}");
        }

        private static void RunNullable(Warehouse warehouse)
        {
            int? threshold = FindThreshold("apple");
            int? missing = FindThreshold("ghost");

            int effective = threshold ?? 0;
            Console.WriteLine($"apple threshold has value: {threshold.HasValue}");
            Console.WriteLine($"apple threshold: {threshold.Value}");
            Console.WriteLine($"ghost threshold has value: {missing.HasValue}");
            Console.WriteLine($"ghost effective (?? 0): {missing ?? 0}");

            int onHand = warehouse.CountOf("apple");
            if (onHand < effective)
            {
                Console.WriteLine($"Reorder apple: {onHand} < {effective}");
            }
            else
            {
                Console.WriteLine($"Apple OK: {onHand} >= {effective}");
            }
        }

        private static int? FindThreshold(string sku)
        {
            if (sku == "apple")
            {
                return 8;
            }

            return null;
        }
    }
}
