// inventory: AwaitExpression
// Core await coverage: await over already-completed tasks (Task.FromResult /
// Task.CompletedTask), awaits nested inside larger expressions (arithmetic,
// interpolation, argument positions), and async methods returning Task and
// Task<T>. Every await is sequential and deterministic.
using System;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class AwaitExpressionFixture
    {
        public static async Task RunAsync()
        {
            int direct = await Task.FromResult(21);
            Console.WriteLine($"AwaitExpression: direct={direct}");

            int sum = await Task.FromResult(10) + await Task.FromResult(32);
            Console.WriteLine($"AwaitExpression: sum={sum}");

            int nested = await Task.FromResult(await Task.FromResult(7) * 3);
            Console.WriteLine($"AwaitExpression: nested={nested}");

            Console.WriteLine($"AwaitExpression: interpolated={await DoubleAsync(8)}");

            await PrintAsync("helper");

            int viaArg = Add(await Task.FromResult(2), await DoubleAsync(3));
            Console.WriteLine($"AwaitExpression: viaArg={viaArg}");

            await TraceReceiver("positional").ReceiveAsync(
                "positional",
                Trace("positional-before", 1),
                await TraceAsync("positional-inner", 2),
                Trace("positional-after", 3));

            await TraceReceiver("named").ReceiveAsync(
                after: Trace("named-after", 6),
                label: "named",
                value: await TraceAsync("named-inner", 5),
                before: Trace("named-before", 4));

            await AwaitExpressionExtensions.ConsumeAsync(
                TraceReceiver("static-extension"),
                await TraceAsync("static-extension-inner", 7));

            await AwaitExpressionExtensions.RunBareAsync();
        }

        private static async Task<int> DoubleAsync(int value)
        {
            int doubled = await Task.FromResult(value * 2);
            return doubled;
        }

        private static async Task PrintAsync(string label)
        {
            await Task.CompletedTask;
            Console.WriteLine($"AwaitExpression: task-returning {label} ran");
        }

        private static int Trace(string label, int value)
        {
            Console.WriteLine($"AwaitExpression: {label}");
            return value;
        }

        private static AwaitExpressionReceiver TraceReceiver(string label)
        {
            Console.WriteLine($"AwaitExpression: {label}-receiver");
            return new AwaitExpressionReceiver(label);
        }

        private static async Task<int> TraceAsync(string label, int value)
        {
            await Task.CompletedTask;
            Console.WriteLine($"AwaitExpression: {label}");
            return value;
        }

        private static int Add(int left, int right)
        {
            return left + right;
        }
    }

    public sealed class AwaitExpressionReceiver
    {
        public AwaitExpressionReceiver(string label)
        {
            Label = label;
        }

        public string Label { get; }

        public async Task ReceiveAsync(
            string label,
            int before,
            int value,
            int after)
        {
            await Task.CompletedTask;
            Console.WriteLine($"AwaitExpression: {label}-outer={before},{value},{after}");
        }
    }

    public static class AwaitExpressionExtensions
    {
        public static async Task ConsumeAsync(
            this AwaitExpressionReceiver receiver,
            int value)
        {
            await Task.CompletedTask;
            Console.WriteLine($"AwaitExpression: {receiver.Label}-outer={value}");
        }

        public static async Task RunBareAsync()
        {
            await ConsumeAsync(
                CreateReceiver("bare-extension"),
                await LoadAsync("bare-extension-inner", 8));
        }

        private static AwaitExpressionReceiver CreateReceiver(string label)
        {
            Console.WriteLine($"AwaitExpression: {label}-receiver");
            return new AwaitExpressionReceiver(label);
        }

        private static async Task<int> LoadAsync(string label, int value)
        {
            await Task.CompletedTask;
            Console.WriteLine($"AwaitExpression: {label}");
            return value;
        }
    }
}
