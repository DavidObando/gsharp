using System;
using System.ComponentModel.Composition;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Language.CodeLens;
using Microsoft.VisualStudio.Language.CodeLens.Remoting;
using Microsoft.VisualStudio.Language.Intellisense;
using Microsoft.VisualStudio.Threading;
using Microsoft.VisualStudio.Utilities;

namespace GSharp.VisualStudio.CodeLens;

[Export(typeof(IAsyncCodeLensDataPointProvider))]
[Name(Id)]
[ContentType("gsharp")]
[Priority(100)]
internal sealed class GSharpReferenceCodeLensDataPointProvider : IAsyncCodeLensDataPointProvider
{
    internal const string Id = "GSharpReferenceCodeLens";
    private const int GSharpReferenceKind = 1 << 24;

    [Import]
    public ICodeLensCallbackService CallbackService { get; set; } = null!;

    public Task<bool> CanCreateDataPointAsync(
        CodeLensDescriptor descriptor,
        CodeLensDescriptorContext context,
        CancellationToken token)
        => Task.FromResult((int)descriptor.Kind == GSharpReferenceKind);

    public Task<IAsyncCodeLensDataPoint> CreateDataPointAsync(
        CodeLensDescriptor descriptor,
        CodeLensDescriptorContext context,
        CancellationToken token)
        => Task.FromResult<IAsyncCodeLensDataPoint>(
            new GSharpReferenceCodeLensDataPoint(descriptor, CallbackService));

    private sealed class GSharpReferenceCodeLensDataPoint : IAsyncCodeLensDataPoint
    {
        private readonly ICodeLensCallbackService callbackService;
        private readonly int referenceCount;
        private readonly int line;
        private readonly int character;

        public GSharpReferenceCodeLensDataPoint(
            CodeLensDescriptor descriptor,
            ICodeLensCallbackService callbackService)
        {
            Descriptor = descriptor;
            this.callbackService = callbackService;
            string[] parts = descriptor.ElementDescription.Split('|');
            _ = int.TryParse(parts.Length > 0 ? parts[0] : null, out referenceCount);
            _ = int.TryParse(parts.Length > 1 ? parts[1] : null, out line);
            _ = int.TryParse(parts.Length > 2 ? parts[2] : null, out character);
        }

        public CodeLensDescriptor Descriptor { get; }

        public event AsyncEventHandler InvalidatedAsync
        {
            add { }
            remove { }
        }

        public Task<CodeLensDataPointDescriptor> GetDataAsync(
            CodeLensDescriptorContext context,
            CancellationToken token)
            => Task.FromResult(new CodeLensDataPointDescriptor
            {
                Description = referenceCount == 1 ? "1 reference" : $"{referenceCount} references",
                TooltipText = "Find all references",
                IntValue = referenceCount,
            });

        public async Task<CodeLensDetailsDescriptor> GetDetailsAsync(
            CodeLensDescriptorContext context,
            CancellationToken token)
        {
            await callbackService.InvokeAsync(
                this,
                "GSharp.CodeLens.ShowReferences",
                new object[] { Descriptor.FilePath, line, character },
                token);
            return null!;
        }
    }
}
