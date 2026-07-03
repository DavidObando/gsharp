// inventory: ClassDeclaration — plain / sealed / abstract+override / static / nested
using System;

namespace Corpus.Grid06
{
    public class PlainCounter
    {
        private int _count;

        public void Bump()
        {
            _count = _count + 1;
        }

        public int Count()
        {
            return _count;
        }
    }

    public sealed class SealedBadge
    {
        private readonly string _label;

        public SealedBadge(string label)
        {
            _label = label;
        }

        public string Label()
        {
            return _label;
        }
    }

    public abstract class ShapeBase
    {
        public abstract int Area();

        public int DoubledArea()
        {
            return Area() * 2;
        }
    }

    public sealed class SquareShape : ShapeBase
    {
        private readonly int _side;

        public SquareShape(int side)
        {
            _side = side;
        }

        public override int Area()
        {
            return _side * _side;
        }
    }

    public static class StaticMath
    {
        public const int Base = 10;

        public static int Triple(int value)
        {
            return value * 3;
        }
    }

    public class OuterHolder
    {
        public class InnerPart
        {
            public int Piece()
            {
                return 5;
            }
        }

        public int FromInner()
        {
            InnerPart inner = new InnerPart();
            return inner.Piece() + 1;
        }
    }

    public static class ClassDeclarationFixture
    {
        public static void Run()
        {
            PlainCounter counter = new PlainCounter();
            counter.Bump();
            counter.Bump();
            Console.WriteLine("ClassDeclaration: plain count=" + counter.Count().ToString());

            SealedBadge badge = new SealedBadge("gold");
            Console.WriteLine("ClassDeclaration: sealed label=" + badge.Label());

            ShapeBase shape = new SquareShape(4);
            Console.WriteLine("ClassDeclaration: abstract area=" + shape.Area().ToString() + " doubled=" + shape.DoubledArea().ToString());

            Console.WriteLine("ClassDeclaration: static triple=" + StaticMath.Triple(StaticMath.Base).ToString());

            OuterHolder outer = new OuterHolder();
            Console.WriteLine("ClassDeclaration: nested=" + outer.FromInner().ToString());
        }
    }
}
