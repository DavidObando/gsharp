// inventory: AwaitExpression — ValueTask / ValueTask<T> probe (reduced)
// Awaits over synchronously-constructed ValueTask values, plus `async`
// methods that *return* ValueTask / ValueTask<T> (issue #1918: previously
// gsc rejected the latter with GS0155 / GS0100, and awaiting a directly
// constructed ValueTask<T> ICE'd with GS9998).
using System;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class AwaitExpressionValueTaskFixture
    {
        private static async ValueTask<int> TripleAsync(int value)
        {
            await Task.CompletedTask;
            return value * 3;
        }

        private static async ValueTask NoteAsync(string label)
        {
            await Task.CompletedTask;
            Console.WriteLine($"AwaitExpressionValueTask: {label} ran");
        }

        public static async Task RunAsync()
        {
            ValueTask<int> ready = new ValueTask<int>(5);
            int five = await ready;
            Console.WriteLine($"AwaitExpressionValueTask: ready={five}");

            ValueTask done = ValueTask.CompletedTask;
            await done;
            Console.WriteLine("AwaitExpressionValueTask: completed ValueTask awaited");

            int triple = await TripleAsync(5);
            Console.WriteLine($"AwaitExpressionValueTask: triple={triple}");

            await NoteAsync("NoteAsync");
        }
    }
}

