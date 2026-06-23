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
using System;
using System.Collections.Generic;

namespace Corpus.L5
{
    // Area 1: an open base with a virtual method and a protected field,
    // exercised through dynamic dispatch.
    internal class Shape
    {
        protected readonly string _name;

        public Shape(string name)
        {
            _name = name;
        }

        public virtual double Area()
        {
            return 0.0;
        }

        public string Describe()
        {
            return _name + " area=" + Area().ToString();
        }
    }

    internal sealed class Circle : Shape
    {
        private readonly double _radius;

        public Circle(double radius)
            : base("circle")
        {
            _radius = radius;
        }

        public override double Area()
        {
            return _radius * _radius;
        }
    }

    internal sealed class Rectangle : Shape
    {
        private readonly double _width;
        private readonly double _height;

        public Rectangle(double width, double height)
            : base("rectangle")
        {
            _width = width;
            _height = height;
        }

        public override double Area()
        {
            return _width * _height;
        }
    }

    // Area 4: a generic class constrained to reference types, holding a value
    // supplied by the caller (a `new()` constraint with `new T()` construction
    // has no canonical G# form yet - see ADR-0115 section G).
    internal sealed class Box<T>
        where T : class
    {
        public readonly T Value;

        public Box(T value)
        {
            Value = value;
        }
    }

    internal sealed class Label
    {
        public string Text { get; set; }

        public Label()
        {
            Text = "empty";
        }
    }

    internal static class Program
    {
        // Area 3: an iterator using yield return. It yields the descriptions of
        // the large shapes (a user-class element type - sequence[Shape] - ICEs
        // the emitter, see ADR-0115 section G).
        private static IEnumerable<string> LargeDescriptions(IReadOnlyList<Shape> shapes, double threshold)
        {
            foreach (Shape shape in shapes)
            {
                if (shape.Area() > threshold)
                {
                    yield return shape.Describe();
                }
            }
        }

        // Area 4: a generic method constrained to IComparable<T>.
        private static T Max<T>(IReadOnlyList<T> items)
            where T : IComparable<T>
        {
            T best = items[0];
            for (int i = 1; i < items.Count; i++)
            {
                if (items[i].CompareTo(best) > 0)
                {
                    best = items[i];
                }
            }

            return best;
        }

        // Area 2: an `is` type pattern (no binder).
        private static string Classify(Shape shape)
        {
            if (shape is Circle)
            {
                return "round";
            }

            return "angular";
        }

        // Area 2: a switch statement over type patterns (side-effecting).
        private static void PrintKind(Shape shape)
        {
            switch (shape)
            {
                case Circle c:
                    Console.WriteLine("circle r2=" + c.Area().ToString());
                    break;
                case Rectangle r:
                    Console.WriteLine("rectangle wh=" + r.Area().ToString());
                    break;
                default:
                    Console.WriteLine("shape");
                    break;
            }
        }

        // Area 2: a switch expression with relational patterns.
        private static string Bucket(double area)
        {
            return area switch
            {
                < 10 => "small",
                < 100 => "medium",
                _ => "large",
            };
        }

        private static int Sign(int n)
        {
            return n switch
            {
                > 0 => 1,
                < 0 => -1,
                _ => 0,
            };
        }

        private static void Main()
        {
            var shapes = new List<Shape>
            {
                new Circle(2),
                new Rectangle(4, 9),
                new Circle(12),
            };

            // Area 1: dynamic dispatch through the base-typed list.
            foreach (Shape shape in shapes)
            {
                Console.WriteLine(shape.Describe());
            }

            // Area 2: pattern classification.
            foreach (Shape shape in shapes)
            {
                Console.WriteLine(Classify(shape) + " " + Bucket(shape.Area()));
                PrintKind(shape);
            }

            Console.WriteLine(Sign(-3).ToString());
            Console.WriteLine(Sign(0).ToString());
            Console.WriteLine(Sign(7).ToString());

            // Area 3: iterator consumed in a foreach.
            foreach (string description in LargeDescriptions(shapes, 30))
            {
                Console.WriteLine("large: " + description);
            }

            // Area 4: generic method + generic class.
            var areas = new List<double> { 12.0, 48.0, 75.0 };
            Console.WriteLine("max=" + Max(areas).ToString());

            var box = new Box<Label>(new Label());
            Console.WriteLine("box=" + box.Value.Text);
        }
    }
}
