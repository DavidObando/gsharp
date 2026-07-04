// inventory: PointerMemberAccessExpression — p->Field on a struct pointer (probe)
// Writes and reads struct fields through a pointer with `->`; also covers a
// method call through `->`, `->` as an assignment target, and a chained
// deref-then-arrow read through a pointer-to-pointer (issue #1905).
using System;

namespace Corpus.Grid12.Constructs
{
    internal struct PmaPoint
    {
        public int X;
        public int Y;

        public int Sum()
        {
            return X + Y;
        }
    }

    public static class PointerMemberAccessExpressionFixture
    {
        public static void Run()
        {
            unsafe
            {
                PmaPoint pt;
                pt.X = 1;
                pt.Y = 2;
                PmaPoint* p = &pt;
                p->X = 10;
                int x = p->X;
                int y = p->Y;
                int sum = p->Sum();
                Console.WriteLine($"PointerMemberAccessExpression: X={x} Y={y} Sum={sum}");

                PmaPoint** pp = &p;
                int chained = (*pp)->X;
                Console.WriteLine($"PointerMemberAccessExpression-Chained: X={chained}");
            }
        }
    }
}
