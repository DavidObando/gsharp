// L2-Library: shapes and a geometry registry.
//
// Exercises (ADR-0115 section B):
//   B.4   class / struct / record (data class) / record struct (data struct)
//   B.6   inheritance + interface implementation, base clause ordering
//   B.10  public vs internal visibility
//   B.11  auto-properties (get/set, get-only, init), enums, static members,
//         method overloads

package Corpus.L2

import System

enum ShapeKind {
    Circle,
    Rectangle,
    Triangle
}

interface IShape {
    prop Kind ShapeKind {
        get;
    }

    func Area() float64;

    func Perimeter() float64;
}

// record struct -> G# `data struct` (value, structural equality), positional.
data struct Point(X float64, Y float64) : IEquatable[Point] {
    func DistanceTo(other Point) float64 {
        let dx = X - other.X
        let dy = Y - other.Y
        return Math.Sqrt((dx * dx) + (dy * dy))
    }
}

// plain struct -> G# `struct` (value), not auto-promoted to inline struct.
struct Dimensions {
    init(width float64, height float64) {
        Width = width
        Height = height
    }

    prop Width float64 {
        get;
        init;
    }

    prop Height float64 {
        get;
        init;
    }
}

// positional record (reference) -> G# `data class`.
open data class NamedColor(Name string, Rgb int32) : IEquatable[NamedColor] { }

class Circle : IShape {
    init(radius float64) {
        Radius = radius
    }

    prop Kind ShapeKind -> ShapeKind.Circle

    prop Radius float64 {
        get;
    }

    func Area() float64 -> Math.PI * Radius * Radius

    func Perimeter() float64 -> 2.0 * Math.PI * Radius
}

class Rectangle : IShape {
    init(dimensions Dimensions) {
        Dimensions = dimensions
    }

    prop Kind ShapeKind -> ShapeKind.Rectangle

    prop Dimensions Dimensions {
        get;
    }

    func Area() float64 -> Dimensions.Width * Dimensions.Height

    func Perimeter() float64 -> 2.0 * (Dimensions.Width + Dimensions.Height)
}

// Static helpers + method overloads. `internal` rounding helper exercises B.10.
shared class Geometry {
    func TotalArea(a IShape, b IShape) float64 -> a.Area() + b.Area()

    // Overload: same name, different arity.
    func TotalArea(a IShape, b IShape, c IShape) float64 -> a.Area() + b.Area() + c.Area()

    func Round(value float64) float64 -> Round(value, 2)

    // Overload: extra parameter.
    func Round(value float64, digits int32) float64 -> Math.Round(value, digits, MidpointRounding.AwayFromZero)

    internal func ToCents(dollars float64) int32 -> int32(RoundHalfUp(dollars * 100.0))

    private func RoundHalfUp(value float64) float64 -> Math.Floor(value + 0.5)
}
