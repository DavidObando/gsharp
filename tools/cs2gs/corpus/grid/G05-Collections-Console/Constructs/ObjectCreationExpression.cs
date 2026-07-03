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

            // QUARANTINED (GS0125/parse): ObjectInitializerExpression —
            // 'new GridPoint { X = 1, Y = 2 }' makes the translator emit the
            // initializer assignments as stray statements ahead of the G#
            // composite literal, and 'new GridPoint(9, 0) { Y = 8 }' emits
            // 'GridPoint(9, 0){Y = 8}' which G# does not accept. Plain
            // property assignment statements are used instead.
            var byProps = new GridPoint();
            byProps.X = 1;
            byProps.Y = 2;
            Console.WriteLine($"ObjectCreationExpression: byProps=({byProps.X},{byProps.Y})");

            // ImplicitObjectCreationExpression (target-typed new, no initializer).
            GridPoint implicitNew = new(7, 7);
            Console.WriteLine($"ObjectCreationExpression: implicitNew=({implicitNew.X},{implicitNew.Y})");
        }
    }
}
