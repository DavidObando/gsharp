// inventory: StructDeclaration — plain struct, readonly struct, struct implementing an interface
using System;

namespace Corpus.Grid06
{
    public struct Vector2
    {
        public int X;
        public int Y;

        public Vector2(int x, int y)
        {
            X = x;
            Y = y;
        }

        public int Sum()
        {
            return X + Y;
        }
    }

    public readonly struct ReadonlyPair
    {
        private readonly int _left;
        private readonly int _right;

        public ReadonlyPair(int left, int right)
        {
            _left = left;
            _right = right;
        }

        public int Product()
        {
            return _left * _right;
        }
    }

    public interface IArea
    {
        int Area();
    }

    public struct Cell : IArea
    {
        private readonly int _side;

        public Cell(int side)
        {
            _side = side;
        }

        public int Area()
        {
            return _side * _side;
        }
    }

    public static class StructDeclarationFixture
    {
        public static void Run()
        {
            Vector2 vector = new Vector2(3, 9);
            Console.WriteLine("StructDeclaration: sum=" + vector.Sum().ToString());

            ReadonlyPair pair = new ReadonlyPair(6, 7);
            Console.WriteLine("StructDeclaration: product=" + pair.Product().ToString());

            Cell cell = new Cell(5);
            Console.WriteLine("StructDeclaration: area=" + cell.Area().ToString());
        }
    }
}
