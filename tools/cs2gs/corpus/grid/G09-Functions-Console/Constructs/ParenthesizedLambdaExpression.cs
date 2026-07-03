// inventory: ParenthesizedLambdaExpression
using System;

namespace Corpus.Grid09
{
    public static class ParenthesizedLambdaExpressionFixture
    {
        public static void Run()
        {
            // Explicitly typed parameters.
            Func<int, int, int> add = (int a, int b) => a + b;
            Console.WriteLine($"ParenthesizedLambdaExpression: add={add(2, 3)}");

            // Implicitly typed multi-parameter.
            Func<int, int, int> mul = (a, b) => a * b;
            Console.WriteLine($"ParenthesizedLambdaExpression: mul={mul(4, 5)}");

            // Zero parameters.
            Func<string> hello = () => "hello";
            Console.WriteLine($"ParenthesizedLambdaExpression: hello={hello()}");

            // Statement-bodied.
            Func<int, int> stmt = (x) =>
            {
                int tripled = x * 3;
                return tripled + 1;
            };
            Console.WriteLine($"ParenthesizedLambdaExpression: stmt={stmt(5)}");

            // Statement-bodied Action. Uses concatenation, not interpolation:
            // the gsc emitter cannot yet emit InterpolatedStringExpression
            // inside lambda bodies (GS9998).
            Action<int, int> report = (a, b) =>
            {
                Console.WriteLine("ParenthesizedLambdaExpression: report=" + a.ToString() + "/" + b.ToString());
            };
            report(6, 7);
        }
    }
}
