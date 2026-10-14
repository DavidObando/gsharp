// L5-Console: the fifth corpus level. A deterministic shape-catalog program
// whose stdout is the parity oracle (no timestamps / random / GUIDs / culture).
//
// It exercises C# surface area that L1-L4 do not, each a candidate gap source
// for the C#->G# migration (ADR-0115 section B / G):
//
//   * Inheritance & polymorphism: an open base class with a virtual method, a
//     derived override, protected members, and dynamic dispatch through a
//     base-typed list.
//   * Pattern matching: an `is` type pattern, a switch statement over type
//     patterns, and switch expressions with relational patterns.
//   * Iterators: a method using `yield return` returning IEnumerable<T>,
//     consumed in a foreach.
//   * Generic constraints: a generic method with where T : IComparable<T> and a
//     generic class with where T : class, new().
//
// Constructs with no canonical G# form (a pure `abstract` method, `base.M()`,
// `when` guards, `and`/`or` patterns, `yield break`, an `is` pattern that binds
// a variable) are intentionally omitted; they are captured as triage gaps in
// ADR-0115 section G rather than exercised here.
//
// Ordinary, idiomatic C# (underscore private fields, no StyleCop header,
// implicit `this`) - the migration *input*, not product code.

package Corpus.L5

import System
import System.Collections.Generic

// Area 1: an open base with a virtual method and a protected field,
// exercised through dynamic dispatch.
internal open class Shape {
    protected let _name string

    init(name string) {
        _name = name
    }

    open func Area() float64 {
        return 0.0
    }

    func Describe() string {
        return _name + " area=" + Area().ToString()
    }
}

internal class Circle : Shape {
    private let _radius float64

    init(radius float64) : base("circle") {
        _radius = radius
    }

    override func Area() float64 {
        return _radius * _radius
    }
}

internal class Rectangle : Shape {
    private let _width float64
    private let _height float64

    init(width float64, height float64) : base("rectangle") {
        _width = width
        _height = height
    }

    override func Area() float64 {
        return _width * _height
    }
}

// Area 4: a generic class constrained to reference types, holding a value
// supplied by the caller (a `new()` constraint with `new T()` construction
// has no canonical G# form yet - see ADR-0115 section G).
internal class Box[T class] {
    let Value T

    init(value T) {
        Value = value
    }
}

internal class Label {
    prop Text string

    init() {
        Text = "empty"
    }
}

private func LargeDescriptions(shapes IReadOnlyList[Shape], threshold float64) sequence[string] {
    for shape in shapes {
        if shape.Area() > threshold {
            yield shape.Describe()
        }
    }
}

private func Max[T IComparable[T]](items IReadOnlyList[T]) T {
    var best = items[0]
    for var i = 1; i < items.Count; i++ {
        if items[i].CompareTo(best) > 0 {
            best = items[i]
        }
    }
    return best
}

private func Classify(shape Shape) string {
    if shape is Circle {
        return "round"
    }
    return "angular"
}

private func PrintKind(shape Shape) {
    switch shape {
        case c is Circle {
            Console.WriteLine("circle r2=" + c.Area().ToString())
        }
        case r is Rectangle {
            Console.WriteLine("rectangle wh=" + r.Area().ToString())
        }
        default {
            Console.WriteLine("shape")
        }
    }
}

private func Bucket(area float64) string {
    return switch area {
        case < 10.0: "small"
        case < 100.0: "medium"
        default: "large"
    }
}

private func Sign(n int32) int32 {
    return switch n {
        case > 0: 1
        case < 0: -1
        default: 0
    }
}

let shapes = List[Shape]{Circle(2.0), Rectangle(4.0, 9.0), Circle(12.0)}

// Area 1: dynamic dispatch through the base-typed list.
for shape in shapes {
    Console.WriteLine(shape.Describe())
}

// Area 2: pattern classification.
for shape in shapes {
    Console.WriteLine(Classify(shape) + " " + Bucket(shape.Area()))
    PrintKind(shape)
}

Console.WriteLine(Sign(-3).ToString())
Console.WriteLine(Sign(0).ToString())
Console.WriteLine(Sign(7).ToString())

// Area 3: iterator consumed in a foreach.
for description in LargeDescriptions(shapes, 30.0) {
    Console.WriteLine("large: " + description)
}

// Area 4: generic method + generic class.
let areas = List[float64]{12.0, 48.0, 75.0}

Console.WriteLine("max=" + Max(areas).ToString())
let box = Box[Label](Label())
Console.WriteLine("box=" + box.Value.Text)
