// L2-Library: shapes and a geometry registry.
//
// Exercises (ADR-0115 section B):
//   B.4   class / struct / record (data class) / record struct (data struct)
//   B.6   inheritance + interface implementation, base clause ordering
//   B.10  public vs internal visibility
//   B.11  auto-properties (get/set, get-only, init), enums, static members,
//         method overloads
using System;

namespace Corpus.L2
{
    public enum ShapeKind
    {
        Circle,
        Rectangle,
        Triangle,
    }

    public interface IShape
    {
        ShapeKind Kind { get; }

        double Area();

        double Perimeter();
    }

    // record struct -> G# `data struct` (value, structural equality), positional.
    public readonly record struct Point(double X, double Y)
    {
        public double DistanceTo(Point other)
        {
            double dx = X - other.X;
            double dy = Y - other.Y;
            return Math.Sqrt((dx * dx) + (dy * dy));
        }
    }

    // plain struct -> G# `struct` (value), not auto-promoted to inline struct.
    public struct Dimensions
    {
        public Dimensions(double width, double height)
        {
            Width = width;
            Height = height;
        }

        public double Width { get; init; }

        public double Height { get; init; }
    }

    // positional record (reference) -> G# `data class`.
    public record NamedColor(string Name, int Rgb);

    public sealed class Circle : IShape
    {
        public Circle(double radius)
        {
            Radius = radius;
        }

        public ShapeKind Kind => ShapeKind.Circle;

        public double Radius { get; }

        public double Area() => Math.PI * Radius * Radius;

        public double Perimeter() => 2.0 * Math.PI * Radius;
    }

    public sealed class Rectangle : IShape
    {
        public Rectangle(Dimensions dimensions)
        {
            Dimensions = dimensions;
        }

        public ShapeKind Kind => ShapeKind.Rectangle;

        public Dimensions Dimensions { get; }

        public double Area() => Dimensions.Width * Dimensions.Height;

        public double Perimeter() => 2.0 * (Dimensions.Width + Dimensions.Height);
    }

    // Static helpers + method overloads. `internal` rounding helper exercises B.10.
    public static class Geometry
    {
        public static double TotalArea(IShape a, IShape b) => a.Area() + b.Area();

        // Overload: same name, different arity.
        public static double TotalArea(IShape a, IShape b, IShape c) =>
            a.Area() + b.Area() + c.Area();

        public static double Round(double value) => Round(value, 2);

        // Overload: extra parameter.
        public static double Round(double value, int digits) =>
            Math.Round(value, digits, MidpointRounding.AwayFromZero);

        internal static int ToCents(double dollars) => (int)RoundHalfUp(dollars * 100.0);

        private static double RoundHalfUp(double value) =>
            Math.Floor(value + 0.5);
    }
}
