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

package Corpus.L4

import System
import System.Collections.Generic

// A custom exception type derived from System.Exception.
internal class InsufficientStockException : Exception {
    init(sku string, message string) : base(message) {
        Sku = sku
    }

    var Sku string
}

// Operator overloading on a value type (money in whole cents).
internal struct Money {
    var Cents int32

    init(cents int32) {
        Cents = cents
    }

    func Equals(other Money) bool {
        return Cents == other.Cents
    }

    override func GetHashCode() int32 {
        return Cents
    }

    func Format() string {
        let dollars = Cents / 100
        let cents = Cents % 100
        return "$$$dollars.${cents:D2}"
    }
}

func (a Money) operator + (b Money) Money {
    return Money(a.Cents + b.Cents)
}

func (a Money) operator * (factor int32) Money {
    return Money(a.Cents * factor)
}

func (a Money) operator == (b Money) bool {
    return a.Cents == b.Cents
}

func (a Money) operator != (b Money) bool {
    return a.Cents != b.Cents
}

// An IDisposable resource whose Dispose() prints, for deterministic
// dispose-ordering observation.
internal class AuditLog : IDisposable {
    private let _name string

    init(name string) {
        _name = name
        Console.WriteLine("[audit] open $_name")
    }

    func Record(entry string) {
        Console.WriteLine("[audit] $_name: $entry")
    }

    func Dispose() {
        Console.WriteLine("[audit] close $_name")
    }
}

internal class Warehouse {
    private let _stock Dictionary[string, int32]
    private let _categories HashSet[string]

    init() {
        _stock = Dictionary[string, int32]()
        _categories = HashSet[string]()
    }

    prop CategoryCount int32 -> _categories.Count

    func Stock(sku string, quantity int32, category string) {
        var existing int32
        if _stock.TryGetValue(sku, out existing) {
            _stock[sku] = existing + quantity
        } else {
            _stock[sku] = quantity
        }
        _categories.Add(category)
    }

    func Remove(sku string, quantity int32) {
        var qty int32
        let available = if _stock.TryGetValue(sku, out qty) {
            qty
        } else {
            0
        }
        if quantity > available {
            throw InsufficientStockException(sku, "cannot remove $quantity of '$sku': only $available in stock")
        }
        _stock[sku] = available - quantity
    }

    func CountOf(sku string) int32 {
        var qty int32
        let found = _stock.TryGetValue(sku, out qty)
        return if found {
            qty
        } else {
            0
        }
    }

    func HasCategory(category string) bool {
        return _categories.Contains(category)
    }

    func PrintStock() {
        let keys = List[string](_stock.Keys)
        keys.Sort()
        for sku in keys {
            Console.WriteLine("  $sku = ${_stock[sku]}")
        }
    }
}

private func RunReconcile(warehouse Warehouse) {
    try {
        Audit(warehouse, "banana", 99)
    } catch (ex InsufficientStockException) {
        Console.WriteLine("Reconcile failed for ${ex.Sku}: ${ex.Message}")
    }
}

private func Audit(warehouse Warehouse, sku string, quantity int32) {
    try {
        warehouse.Remove(sku, quantity)
    } catch (ex InsufficientStockException) {
        Console.WriteLine("Audit rethrow (${ex.Sku})")
        rethrow
    }
}

private func RunLedger(warehouse Warehouse) {
    {
        using let log = AuditLog("ledger")
        log.Record("start")
        TryRemove(warehouse, "apple", 4, log)
        TryRemove(warehouse, "wrench", 9, log)
        log.Record("end")
    }
    using let summary = AuditLog("summary")
    summary.Record("apples remaining: ${warehouse.CountOf("apple")}")
}

private func TryRemove(warehouse Warehouse, sku string, quantity int32, log AuditLog) {
    try {
        warehouse.Remove(sku, quantity)
        log.Record("removed $quantity $sku")
    } catch (ex InsufficientStockException) {
        Console.WriteLine("Rejected: ${ex.Message}")
        log.Record("rejected $sku")
    } finally {
        log.Record("done $sku")
    }
}

private func RunMoney() {
    var unit = Money(250)
    var three = unit * 3
    var bundle = three + Money(99)
    Console.WriteLine("Unit price: ${unit.Format()}")
    Console.WriteLine("Three units: ${three.Format()}")
    Console.WriteLine("Bundle: ${bundle.Format()}")
    Console.WriteLine("three == bundle: ${three == bundle}")
    Console.WriteLine("three != bundle: ${three != bundle}")
    Console.WriteLine("unit*3 == three: ${unit * 3 == three}")
    Console.WriteLine("Equal via Equals: ${three.Equals(unit * 3)}")
}

private func RunNullable(warehouse Warehouse) {
    let threshold = FindThreshold("apple")
    let missing = FindThreshold("ghost")
    let effective = threshold ?? 0
    Console.WriteLine("apple threshold has value: ${(threshold != nil)}")
    Console.WriteLine("apple threshold: ${threshold!!}")
    Console.WriteLine("ghost threshold has value: ${(missing != nil)}")
    Console.WriteLine("ghost effective (?? 0): ${missing ?? 0}")
    let onHand = warehouse.CountOf("apple")
    if onHand < effective {
        Console.WriteLine("Reorder apple: $onHand < $effective")
    } else {
        Console.WriteLine("Apple OK: $onHand >= $effective")
    }
}

private func FindThreshold(sku string) int32? {
    if sku == "apple" {
        return 8
    }
    return nil
}

let warehouse = Warehouse()
warehouse.Stock("apple", 10, "fruit")
warehouse.Stock("banana", 6, "fruit")
warehouse.Stock("wrench", 3, "tool")
warehouse.Stock("apple", 5, "fruit")
Console.WriteLine("Stock levels:")
warehouse.PrintStock()
Console.WriteLine("Categories tracked: ${warehouse.CategoryCount}")
Console.WriteLine("Has 'tool' category: ${warehouse.HasCategory("tool")}")
Console.WriteLine("Has 'spice' category: ${warehouse.HasCategory("spice")}")
Console.WriteLine()
RunLedger(warehouse)
Console.WriteLine()
RunMoney()
Console.WriteLine()
RunNullable(warehouse)
Console.WriteLine()
RunReconcile(warehouse)
