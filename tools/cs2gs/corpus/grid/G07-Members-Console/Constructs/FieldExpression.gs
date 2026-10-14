// inventory: FieldExpression — C#14 `field` contextual keyword in property accessors:
// custom-set + auto-get sharing one field, get-with-`??=` + auto-set, both-custom,
// and a property initializer seeding the synthesized backing field.

package Corpus.Grid07

import System

open class ClampedGauge {
    // Custom set (clamps via `field`), auto get sharing the same backing field.
    private var _level int32

    prop Level int32 {
        get -> _level
        set -> _level = if value < 0 {
            0
        } else {
            value
        }
    }
}

open class ClampedGaugeWithInit {
    // Initializer seeds the compiler-synthesized backing field, not just the property.
    private var _level2 int32 = 5

    prop Level int32 {
        get {
            return _level2
        }
        set -> _level2 = if value < 0 {
            0
        } else {
            value
        }
    }
}

open class LazyLabel {
    // Get-with-`field` lazy-init (`??=`), auto set writing the same field.
    private var _name string?

    prop Name string {
        get -> (
            if _name == nil {
                (_name = "default")
            } else {
                _name
            }
        )!!
        set {
            _name = value
        }
    }
}

open class LoggedCounter {
    private var changeCount int32

    // Both accessors custom, both touching `field`.
    private var _count int32

    prop Count int32 {
        get -> _count
        set {
            _count = value
            changeCount = changeCount + 1
        }
    }

    prop ChangeCount int32 -> changeCount
}

shared class FieldExpressionFixture {
    func Run() {
        let gauge = ClampedGauge()
        gauge.Level = 12
        Console.WriteLine("FieldExpression: set=" + gauge.Level.ToString())
        gauge.Level = -4
        Console.WriteLine("FieldExpression: clamped=" + gauge.Level.ToString())
        let label = LazyLabel()
        Console.WriteLine("FieldExpression: lazy=" + label.Name)
        label.Name = "explicit"
        Console.WriteLine("FieldExpression: overwritten=" + label.Name)
        let counter = LoggedCounter()
        counter.Count = 1
        counter.Count = 2
        Console.WriteLine("FieldExpression: counter=" + counter.Count.ToString())
        Console.WriteLine("FieldExpression: changes=" + counter.ChangeCount.ToString())
        let initGauge = ClampedGaugeWithInit()
        Console.WriteLine("FieldExpression: init=" + initGauge.Level.ToString())
        initGauge.Level = -1
        Console.WriteLine("FieldExpression: initClamped=" + initGauge.Level.ToString())
    }
}
