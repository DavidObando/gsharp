using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.IO;
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
[DetailsTemplateName("references")]
internal sealed class GSharpReferenceCodeLensDataPointProvider : IAsyncCodeLensDataPointProvider
{
    internal const string Id = "GSharpReferenceCodeLens";
    private const int GSharpReferenceKind = 1 << 24;

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
            new GSharpReferenceCodeLensDataPoint(descriptor));

    private sealed class GSharpReferenceCodeLensDataPoint : IAsyncCodeLensDataPoint
    {
        private static readonly List<CodeLensDetailHeaderDescriptor> Headers = new List<CodeLensDetailHeaderDescriptor>
        {
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.FilePath },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.LineNumber },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.ColumnNumber },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.ReferenceText },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.ReferenceStart },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.ReferenceEnd },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.ReferenceLongDescription },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.ReferenceImageId },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.TextBeforeReference2 },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.TextBeforeReference1 },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.TextAfterReference1 },
            new CodeLensDetailHeaderDescriptor { UniqueName = ReferenceEntryFieldNames.TextAfterReference2 },
        };

        private readonly GSharpReferenceCodeLensPayload payload;

        public GSharpReferenceCodeLensDataPoint(CodeLensDescriptor descriptor)
        {
            Descriptor = descriptor;
            payload = GSharpReferenceCodeLensPayload.Parse(descriptor.ElementDescription);
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
                Description = payload.References.Count == 1
                    ? "1 reference"
                    : $"{payload.References.Count} references",
                TooltipText = "Find all references",
                IntValue = payload.References.Count,
            });

        public Task<CodeLensDetailsDescriptor> GetDetailsAsync(
            CodeLensDescriptorContext context,
            CancellationToken token)
        {
            var entries = new List<CodeLensDetailEntryDescriptor>(payload.References.Count);
            var sources = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
            foreach (GSharpReferenceCodeLensLocation reference in payload.References)
            {
                token.ThrowIfCancellationRequested();
                var uri = new Uri(reference.Uri, UriKind.Absolute);
                if (!uri.IsFile)
                {
                    throw new InvalidOperationException($"CodeLens cannot navigate the non-file URI '{reference.Uri}'.");
                }

                string filePath = uri.LocalPath;
                if (!sources.TryGetValue(filePath, out string[]? lines))
                {
                    lines = File.ReadAllLines(filePath);
                    sources.Add(filePath, lines);
                }

                if (reference.Line >= lines.Length)
                {
                    throw new InvalidOperationException(
                        $"CodeLens reference line {reference.Line} is outside '{filePath}'.");
                }

                string lineText = lines[reference.Line];
                int start = Math.Min(reference.Character, lineText.Length);
                int end = Math.Min(reference.EndCharacter, lineText.Length);
                entries.Add(new CodeLensDetailEntryDescriptor
                {
                    Fields = new List<CodeLensDetailEntryField>
                    {
                        new CodeLensDetailEntryField { Text = filePath },
                        new CodeLensDetailEntryField { Text = reference.Line.ToString() },
                        new CodeLensDetailEntryField { Text = reference.Character.ToString() },
                        new CodeLensDetailEntryField { Text = lineText },
                        new CodeLensDetailEntryField { Text = start.ToString() },
                        new CodeLensDetailEntryField { Text = end.ToString() },
                        new CodeLensDetailEntryField { Text = $"{filePath} ({reference.Line + 1},{reference.Character + 1})" },
                        new CodeLensDetailEntryField(),
                        new CodeLensDetailEntryField { Text = string.Empty },
                        new CodeLensDetailEntryField { Text = string.Empty },
                        new CodeLensDetailEntryField { Text = string.Empty },
                        new CodeLensDetailEntryField { Text = string.Empty },
                    },
                });
            }

            return Task.FromResult(new CodeLensDetailsDescriptor
            {
                Headers = Headers,
                Entries = entries,
            });
        }
    }
}
