// inventory: ArrayCreationExpression — multi-dim rank>1 sub-case (#1893).
using System;

namespace Corpus.Grid05
{
    public static class ArrayCreationExpressionMultiDimFixture
    {
        public static void Run()
        {
            int[,] grid = new int[2, 3];
            grid[0, 0] = 1;
            grid[0, 1] = 2;
            grid[0, 2] = 3;
            grid[1, 0] = 4;
            grid[1, 1] = 5;
            grid[1, 2] = 6;

            int sum = 0;
            for (int r = 0; r < grid.GetLength(0); r++)
            {
                for (int c = 0; c < grid.GetLength(1); c++)
                {
                    sum += grid[r, c];
                }
            }

            Console.WriteLine($"ArrayCreationExpressionMultiDim: sum={sum} rows={grid.GetLength(0)} cols={grid.GetLength(1)}");

            int[,] lit = new int[,] { { 1, 2, 3 }, { 4, 5, 6 } };
            Console.WriteLine($"ArrayCreationExpressionMultiDim: lit[1,2]={lit[1, 2]} lit[0,1]={lit[0, 1]}");
        }
    }
}
