// inventory: AwaitExpression
// Core await coverage: await over already-completed tasks (Task.FromResult /
// Task.CompletedTask), awaits nested inside larger expressions (arithmetic,
// interpolation, argument positions), and async methods returning Task and
// Task<T>. Every await is sequential and deterministic.

package Corpus.Grid10.Constructs

import System
import System.Threading.Tasks

shared class AwaitExpressionFixture {
    async func RunAsync() {
        let direct = await Task.FromResult(21)
        Console.WriteLine("AwaitExpression: direct=$direct")
        let sum = await Task.FromResult(10) + await Task.FromResult(32)
        Console.WriteLine("AwaitExpression: sum=$sum")
        let nested = await Task.FromResult(await Task.FromResult(7) * 3)
        Console.WriteLine("AwaitExpression: nested=$nested")
        Console.WriteLine("AwaitExpression: interpolated=${await DoubleAsync(8)}")
        await PrintAsync("helper")
        let viaArg = Add(await Task.FromResult(2), await DoubleAsync(3))
        Console.WriteLine("AwaitExpression: viaArg=$viaArg")
        await TraceReceiver("positional").ReceiveAsync(
            "positional",
            Trace("positional-before", 1),
            await TraceAsync("positional-inner", 2),
            Trace("positional-after", 3)
        )
        await TraceReceiver("named").ReceiveAsync(
            after: Trace("named-after", 6),
            label: "named",
            value: await TraceAsync("named-inner", 5),
            before: Trace("named-before", 4)
        )
        await AwaitExpressionExtensions.ConsumeAsync(
            TraceReceiver("static-extension"),
            await TraceAsync("static-extension-inner", 7)
        )
        await AwaitExpressionExtensions.RunBareAsync()
    }

    private async func DoubleAsync(value int32) int32 {
        let doubled = await Task.FromResult(value * 2)
        return doubled
    }

    private async func PrintAsync(label string) {
        await Task.CompletedTask
        Console.WriteLine("AwaitExpression: task-returning $label ran")
    }

    private func Trace(label string, value int32) int32 {
        Console.WriteLine("AwaitExpression: $label")
        return value
    }

    private func TraceReceiver(label string) AwaitExpressionReceiver {
        Console.WriteLine("AwaitExpression: $label-receiver")
        return AwaitExpressionReceiver(label)
    }

    private async func TraceAsync(label string, value int32) int32 {
        await Task.CompletedTask
        Console.WriteLine("AwaitExpression: $label")
        return value
    }

    private func Add(left int32, right int32) int32 {
        return left + right
    }
}

class AwaitExpressionReceiver {
    init(label string) {
        Label = label
    }

    prop Label string {
        get;
    }

    async func ReceiveAsync(label string, before int32, value int32, after int32) {
        await Task.CompletedTask
        Console.WriteLine("AwaitExpression: $label-outer=$before,$value,$after")
    }
}

shared class AwaitExpressionExtensions {
    async func RunBareAsync() {
        await ConsumeAsync(CreateReceiver("bare-extension"), await LoadAsync("bare-extension-inner", 8))
    }

    private func CreateReceiver(label string) AwaitExpressionReceiver {
        Console.WriteLine("AwaitExpression: $label-receiver")
        return AwaitExpressionReceiver(label)
    }

    private async func LoadAsync(label string, value int32) int32 {
        await Task.CompletedTask
        Console.WriteLine("AwaitExpression: $label")
        return value
    }
}

@ExtensionOwner(typeof(AwaitExpressionExtensions))
async func (receiver AwaitExpressionReceiver) ConsumeAsync(value int32) {
    await Task.CompletedTask
    Console.WriteLine("AwaitExpression: ${receiver.Label}-outer=$value")
}
