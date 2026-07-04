// inventory: ObjectCreationExpression
using System;

namespace Corpus.Grid05
{
    public sealed class GridPoint
    {
        public GridPoint()
        {
        }

        public GridPoint(int x, int y)
        {
            X = x;
            Y = y;
        }

        public int X { get; set; }

        public int Y { get; set; }
    }

    public static class ObjectCreationExpressionFixture
    {
        public static void Run()
        {
            var byCtor = new GridPoint(3, 4);
            Console.WriteLine($"ObjectCreationExpression: byCtor=({byCtor.X},{byCtor.Y})");

            // Issue #1892: a plain object initializer with no constructor args.
            var byInit = new GridPoint { X = 1, Y = 2 };
            Console.WriteLine($"ObjectCreationExpression: byInit=({byInit.X},{byInit.Y})");

            // Issue #1892: constructor args PLUS an object initializer.
            var byCtorAndInit = new GridPoint(9, 0) { Y = 8 };
            Console.WriteLine($"ObjectCreationExpression: byCtorAndInit=({byCtorAndInit.X},{byCtorAndInit.Y})");

            // ImplicitObjectCreationExpression (target-typed new, no initializer).
            GridPoint implicitNew = new(7, 7);
            Console.WriteLine($"ObjectCreationExpression: implicitNew=({implicitNew.X},{implicitNew.Y})");
        }
    }
}
