using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Language.CodeLens;
using Microsoft.VisualStudio.Language.Intellisense;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Tagging;
using Microsoft.VisualStudio.Utilities;

namespace GSharp.VisualStudio;

[Export(typeof(ITaggerProvider))]
[ContentType(GSharpContentTypeDefinitions.ContentTypeName)]
[TagType(typeof(ICodeLensTag))]
internal sealed class GSharpCodeLensTaggerProvider : ITaggerProvider
{
    private readonly GSharpLanguageServerRpc rpc;
    private readonly ITextDocumentFactoryService documentFactory;
    private readonly object syncRoot = new();
    private readonly List<WeakReference<GSharpCodeLensTagger>> taggers = new();

    [ImportingConstructor]
    public GSharpCodeLensTaggerProvider(
        GSharpLanguageServerRpc rpc,
        ITextDocumentFactoryService documentFactory)
    {
        this.rpc = rpc;
        this.documentFactory = documentFactory;
        rpc.StateChanged += OnRpcStateChanged;
    }

    public ITagger<T>? CreateTagger<T>(ITextBuffer buffer)
        where T : ITag
    {
        if (typeof(T) != typeof(ICodeLensTag)
            || !documentFactory.TryGetTextDocument(buffer, out ITextDocument document))
        {
            return null;
        }

        return buffer.Properties.GetOrCreateSingletonProperty(
            () =>
            {
                var tagger = new GSharpCodeLensTagger(buffer, document, rpc, RefreshAll);
                lock (syncRoot)
                {
                    taggers.Add(new WeakReference<GSharpCodeLensTagger>(tagger));
                }

                return tagger;
            }) as ITagger<T>;
    }

    private void OnRpcStateChanged(object? sender, EventArgs e)
    {
        ForEachTagger(tagger => tagger.OnRpcStateChanged());
    }

    private void RefreshAll()
    {
        ForEachTagger(tagger => tagger.ScheduleRefresh());
    }

    private void ForEachTagger(Action<GSharpCodeLensTagger> action)
    {
        var targets = new List<GSharpCodeLensTagger>();
        lock (syncRoot)
        {
            for (int i = taggers.Count - 1; i >= 0; i--)
            {
                if (taggers[i].TryGetTarget(out GSharpCodeLensTagger? tagger))
                {
                    targets.Add(tagger);
                }
                else
                {
                    taggers.RemoveAt(i);
                }
            }
        }

        foreach (GSharpCodeLensTagger tagger in targets)
        {
            action(tagger);
        }
    }
}

internal sealed class GSharpCodeLensTagger : ITagger<ICodeLensTag>
{
    private readonly ITextBuffer buffer;
    private readonly ITextDocument document;
    private readonly GSharpLanguageServerRpc rpc;
    private readonly Action refreshAll;
    private readonly object refreshLock = new();
    private CancellationTokenSource? refreshCancellation;
    private int refreshGeneration;
    private IReadOnlyList<GSharpReferenceCodeLens> lenses = Array.Empty<GSharpReferenceCodeLens>();

    public GSharpCodeLensTagger(
        ITextBuffer buffer,
        ITextDocument document,
        GSharpLanguageServerRpc rpc,
        Action refreshAll)
    {
        this.buffer = buffer;
        this.document = document;
        this.rpc = rpc;
        this.refreshAll = refreshAll;
        buffer.Changed += OnBufferChanged;
        document.FileActionOccurred += OnFileActionOccurred;
        ScheduleRefresh();
    }

    public event EventHandler<SnapshotSpanEventArgs>? TagsChanged;

    public IEnumerable<ITagSpan<ICodeLensTag>> GetTags(NormalizedSnapshotSpanCollection spans)
    {
        if (spans.Count == 0)
        {
            yield break;
        }

        ITextSnapshot snapshot = spans[0].Snapshot;
        IReadOnlyList<GSharpReferenceCodeLens> currentLenses;
        lock (refreshLock)
        {
            currentLenses = lenses;
        }

        foreach (GSharpReferenceCodeLens lens in currentLenses)
        {
            if (!TryGetSnapshotSpan(snapshot, lens.DeclarationRange, out SnapshotSpan span)
                || !spans.IntersectsWith(span))
            {
                continue;
            }

            yield return new TagSpan<ICodeLensTag>(
                span,
                new GSharpCodeLensTag(
                    document.FilePath,
                    span,
                    lens.References
                        .Where(reference =>
                            reference.Uri != null
                            && reference.Range?.Start != null
                            && reference.Range.End != null
                            && reference.Range.Start.Line == reference.Range.End.Line)
                        .Select(reference => new GSharpReferenceCodeLensLocation(
                            reference.Uri!,
                            reference.Range!.Start!.Line,
                            reference.Range.Start.Character,
                            reference.Range.End!.Character))));
        }
    }

    private static bool TryGetSnapshotSpan(
        ITextSnapshot snapshot,
        GSharpRange? range,
        out SnapshotSpan span)
    {
        span = default;
        if (range?.Start == null || range.End == null
            || range.Start.Line < 0 || range.Start.Line >= snapshot.LineCount
            || range.End.Line < 0 || range.End.Line >= snapshot.LineCount)
        {
            return false;
        }

        ITextSnapshotLine startLine = snapshot.GetLineFromLineNumber(range.Start.Line);
        ITextSnapshotLine endLine = snapshot.GetLineFromLineNumber(range.End.Line);
        int anchor = GSharpCodeLensAnchor.Find(startLine.GetText(), range.Start.Character);
        int start = startLine.Start.Position + anchor;
        int end = Math.Min(endLine.Start.Position + range.End.Character, endLine.End.Position);
        if (end <= start)
        {
            return false;
        }

        span = new SnapshotSpan(snapshot, Span.FromBounds(start, end));
        return true;
    }

    private void OnBufferChanged(object sender, TextContentChangedEventArgs e) => refreshAll();

    private void OnFileActionOccurred(object sender, TextDocumentFileActionEventArgs e) => refreshAll();

    internal void ScheduleRefresh()
    {
        var current = new CancellationTokenSource();
        int generation;
        int version;
        lock (refreshLock)
        {
            refreshCancellation?.Cancel();
            refreshCancellation = current;
            generation = ++refreshGeneration;
            version = buffer.CurrentSnapshot.Version.VersionNumber;
        }

        _ = RefreshAsync(version, generation, current);
    }

    internal void OnRpcStateChanged()
    {
        if (rpc.IsReady)
        {
            ScheduleRefresh();
            return;
        }

        CancellationTokenSource? current;
        lock (refreshLock)
        {
            current = refreshCancellation;
            current?.Cancel();
            refreshCancellation = null;
            refreshGeneration++;
            lenses = Array.Empty<GSharpReferenceCodeLens>();
        }

        RaiseTagsChanged();
    }

    private async Task RefreshAsync(
        int requestedVersion,
        int requestedGeneration,
        CancellationTokenSource cancellation)
    {
        CancellationToken token = cancellation.Token;
        try
        {
            await Task.Delay(150, token);
            GSharpReferenceCodeLens[]? result = null;
            for (int attempt = 0; attempt < 40 && result == null; attempt++)
            {
                try
                {
                    result = await rpc.GetReferenceCodeLensesAsync(
                        new Uri(document.FilePath).AbsoluteUri,
                        token);
                }
                catch (InvalidOperationException)
                {
                    await Task.Delay(250, token);
                }
            }

            if (result == null)
            {
                return;
            }

            lock (refreshLock)
            {
                if (token.IsCancellationRequested
                    || requestedGeneration != refreshGeneration
                    || buffer.CurrentSnapshot.Version.VersionNumber != requestedVersion)
                {
                    return;
                }

                lenses = result;
            }

            RaiseTagsChanged();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            GSharpLog.Write($"CodeLens refresh failed: {ex.Message}");
        }
        finally
        {
            lock (refreshLock)
            {
                if (ReferenceEquals(refreshCancellation, cancellation))
                {
                    refreshCancellation = null;
                }
            }

            cancellation.Dispose();
        }
    }

    private void RaiseTagsChanged()
    {
        ITextSnapshot snapshot = buffer.CurrentSnapshot;
        TagsChanged?.Invoke(
            this,
            new SnapshotSpanEventArgs(new SnapshotSpan(snapshot, 0, snapshot.Length)));
    }
}

internal sealed class GSharpCodeLensTag : ICodeLensTag3, ICodeLensDescriptorContextProvider
{
    public GSharpCodeLensTag(
        string filePath,
        SnapshotSpan span,
        IEnumerable<GSharpReferenceCodeLensLocation> references)
    {
        Descriptor = new GSharpCodeLensDescriptor
        {
            FilePath = filePath,
            ProjectGuid = Guid.Empty,
            ElementDescription = GSharpReferenceCodeLensPayload.Serialize(references),
            ApplicableSpan = span,
            Kind = (CodeElementKinds)(1 << 24),
        };
        Properties = new CodeLensTagProperties(displayBeforeCreatingDataPoints: true);
    }

    public ICodeLensDescriptor Descriptor { get; }

    public ICodeLensDescriptorContextProvider DescriptorContextProvider => this;

    public CodeLensTagProperties Properties { get; }

    public event EventHandler Disconnected
    {
        add { }
        remove { }
    }

    public Task<CodeLensDescriptorContext> GetCurrentContextAsync()
        => Task.FromResult(new CodeLensDescriptorContext(
            Descriptor.ApplicableSpan,
            new Dictionary<object, object>()));
}

internal sealed class GSharpCodeLensDescriptor : ICodeLensDescriptor
{
    public string FilePath { get; set; } = string.Empty;

    public Guid ProjectGuid { get; set; }

    public string ElementDescription { get; set; } = string.Empty;

    public Span? ApplicableSpan { get; set; }

    public CodeElementKinds Kind { get; set; }
}
