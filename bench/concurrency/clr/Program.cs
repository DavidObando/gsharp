using System.Diagnostics;
using System.Threading.Channels;
using System.Threading.Tasks.Sources;
using Gsharp.Concurrency;

// ---------------------------------------------------------------------------
// PART 1 — feasibility: can a G#-owned channel type derive from the BCL
// Channel<T> and stay interop-transparent?
// ---------------------------------------------------------------------------

sealed class GoChan<T> : Channel<T>
{
    private readonly Channel<T> inner;

    public GoChan(int capacity)
    {
        inner = Channel.CreateBounded<T>(
            new BoundedChannelOptions(capacity == 0 ? 1 : capacity) { AllowSynchronousContinuations = true });
        Reader = new GoReader(this);
        Writer = new GoWriter(this);
    }

    // The extra, Go-shaped surface the compiler would emit calls to.
    public bool TryReceive(out T value, out bool ok)
    {
        if (inner.Reader.TryRead(out value!)) { ok = true; return true; }
        if (inner.Reader.Completion.IsCompleted) { value = default!; ok = false; return true; }
        ok = false; return false;
    }

    private sealed class GoReader : ChannelReader<T>
    {
        private readonly GoChan<T> c;
        public GoReader(GoChan<T> c) => this.c = c;
        public override bool TryRead(out T item) => c.inner.Reader.TryRead(out item!);
        public override ValueTask<bool> WaitToReadAsync(CancellationToken ct = default) => c.inner.Reader.WaitToReadAsync(ct);
        public override Task Completion => c.inner.Reader.Completion;
        public override bool CanCount => c.inner.Reader.CanCount;
        public override int Count => c.inner.Reader.Count;
    }

    private sealed class GoWriter : ChannelWriter<T>
    {
        private readonly GoChan<T> c;
        public GoWriter(GoChan<T> c) => this.c = c;
        public override bool TryWrite(T item) => c.inner.Writer.TryWrite(item);
        public override ValueTask<bool> WaitToWriteAsync(CancellationToken ct = default) => c.inner.Writer.WaitToWriteAsync(ct);
        public override bool TryComplete(Exception? error = null) => c.inner.Writer.TryComplete(error);
    }
}

// ---------------------------------------------------------------------------
// PART 2 — a Go-shaped hchan: ring buffer + parked waiters, IValueTaskSource
// based, no Task allocation on the park path. Proof of the achievable floor.
// ---------------------------------------------------------------------------

sealed class Hchan<T>
{
    private readonly T[] buf;
    private readonly int cap;
    private int head, tail, count;
    private bool closed;
    private readonly object gate = new();
    private readonly Queue<Waiter> recvq = new();
    private readonly Queue<Waiter> sendq = new();
    private Waiter? pool;

    public Hchan(int capacity) { cap = capacity; buf = new T[Math.Max(capacity, 1)]; }

    internal sealed class Waiter : IValueTaskSource<bool>
    {
        private ManualResetValueTaskSourceCore<bool> core;
        internal Waiter? next;
        internal T item = default!;
        public Waiter() { core.RunContinuationsAsynchronously = true; }
        public short Version => core.Version;
        public void Reset() => core.Reset();
        public void Complete(bool ok) => core.SetResult(ok);
        public bool GetResult(short token) => core.GetResult(token);
        ValueTaskSourceStatus IValueTaskSource<bool>.GetStatus(short token) => core.GetStatus(token);
        void IValueTaskSource<bool>.OnCompleted(Action<object?> c, object? s, short t, ValueTaskSourceOnCompletedFlags f) => core.OnCompleted(c, s, t, f);
    }

    private Waiter Rent()
    {
        var w = pool;
        if (w is null) return new Waiter();
        pool = w.next; w.next = null; w.Reset(); return w;
    }

    public ValueTask<bool> SendAsync(T value)
    {
        Waiter w;
        for (int spin = 0; spin < 4; spin++)          // spin before parking, as Go's runtime does for locks
        {
            lock (gate)
            {
                if (recvq.Count > 0) { var r0 = recvq.Dequeue(); r0.item = value; r0.Complete(true); return new ValueTask<bool>(true); }
                if (count < cap) { buf[tail] = value; tail = (tail + 1) % buf.Length; count++; return new ValueTask<bool>(true); }
            }
            Thread.SpinWait(1 << spin);
        }
        lock (gate)
        {
            if (closed) throw new InvalidOperationException("send on closed channel");
            if (recvq.Count > 0)                      // direct hand-off — Go's fast path
            {
                var r = recvq.Dequeue();
                r.item = value;
                r.Complete(true);
                return new ValueTask<bool>(true);
            }
            if (count < cap) { buf[tail] = value; tail = (tail + 1) % buf.Length; count++; return new ValueTask<bool>(true); }
            w = Rent(); w.item = value; sendq.Enqueue(w);
        }
        return new ValueTask<bool>(w, w.Version);
    }

    public ValueTask<bool> ReceiveAsync(out T immediate)
    {
        Waiter w;
        for (int spin = 0; spin < 4; spin++)
        {
            lock (gate)
            {
                if (count > 0)
                {
                    immediate = buf[head]; buf[head] = default!; head = (head + 1) % buf.Length; count--;
                    if (sendq.Count > 0) { var s0 = sendq.Dequeue(); buf[tail] = s0.item; tail = (tail + 1) % buf.Length; count++; s0.Complete(true); }
                    return new ValueTask<bool>(true);
                }
                if (sendq.Count > 0) { var s1 = sendq.Dequeue(); immediate = s1.item; s1.Complete(true); return new ValueTask<bool>(true); }
                if (closed) { immediate = default!; return new ValueTask<bool>(false); }
            }
            Thread.SpinWait(1 << spin);
        }
        lock (gate)
        {
            if (count > 0)
            {
                immediate = buf[head]; buf[head] = default!; head = (head + 1) % buf.Length; count--;
                if (sendq.Count > 0) { var s = sendq.Dequeue(); buf[tail] = s.item; tail = (tail + 1) % buf.Length; count++; s.Complete(true); }
                return new ValueTask<bool>(true);
            }
            if (sendq.Count > 0) { var s = sendq.Dequeue(); immediate = s.item; s.Complete(true); return new ValueTask<bool>(true); }
            if (closed) { immediate = default!; return new ValueTask<bool>(false); }
            w = Rent(); recvq.Enqueue(w);
        }
        immediate = default!;
        return new ValueTask<bool>(w, w.Version);
    }

    public void Close()
    {
        lock (gate)
        {
            closed = true;
            while (recvq.Count > 0) recvq.Dequeue().Complete(false);
        }
    }
}

static class Program
{
    const int N = 1_000_000;

    static async Task Main(string[] args)
    {
        // --quick skips the 60 s starvation spike (ADR-0174 Evidence item 3),
        // which is a correctness demonstration rather than a number to re-measure.
        var quick = Array.IndexOf(args, "--quick") >= 0;
        Console.WriteLine($"runtime={Environment.Version} cores={Environment.ProcessorCount}");
        Console.WriteLine();

        await Interop();
        for (int round = 1; round <= 3; round++)
        {
            Console.WriteLine($"-- round {round} --");
            ThroughputCurrentShape();
            ThroughputValueTask();
            await ThroughputAsync();
            await ThroughputHchan();
            await ThroughputBatched();
            await ThroughputChunked();
            await ThroughputChunkedSimd();
            await ComputeStage();
            PingPongBounded1();
            await PingPongRendezvous();
            ClosedReceiveCost();
            SpawnCost();
            await SelectCost();
        }
        await ParkScale();
        if (!quick) Starvation();
    }

    static async Task Interop()
    {
        var ch = new GoChan<int>(4);
        ch.Writer.TryWrite(1); ch.Writer.TryWrite(2); ch.Writer.Complete();

        Channel<int> asBase = ch;                       // (a) flows as Channel<T>
        int sum = 0;
        await foreach (var v in asBase.Reader.ReadAllAsync()) sum += v;   // (b) BCL consumer
        var ch2 = new GoChan<int>(1); ch2.Writer.Complete();
        ch2.TryReceive(out _, out var ok);              // (c) two-value receive, no exception
        Console.WriteLine($"[interop     ] subclass Channel<T> OK; ReadAllAsync sum={sum}; closed-recv ok={ok} (no exception)");
    }

    static void Report(string name, Stopwatch sw, long ops)
        => Console.WriteLine($"[{name,-12}] {sw.Elapsed.TotalMilliseconds,8:F1} ms   {sw.Elapsed.TotalNanoseconds / ops,7:F1} ns/op");

    static void ThroughputCurrentShape()
    {
        var ch = Channel.CreateBounded<int>(new BoundedChannelOptions(64));
        var sw = Stopwatch.StartNew();
        var p = new Thread(() => { for (int i = 0; i < N; i++) ch.Writer.WriteAsync(i).AsTask().GetAwaiter().GetResult(); ch.Writer.Complete(); });
        long sum = 0;
        var c = new Thread(() => { try { for (int i = 0; i < N; i++) sum += ch.Reader.ReadAsync().AsTask().GetAwaiter().GetResult(); } catch (ChannelClosedException) { } });
        p.Start(); c.Start(); p.Join(); c.Join(); sw.Stop();
        Report("gs-today", sw, N);
    }

    // Best achievable *blocking* lowering: Try* fast path, AsTask only when it
    // actually has to park. (Blocking directly on Channels' ValueTask throws —
    // it is IValueTaskSource-backed, so `.AsTask()` is not removable.)
    static void ThroughputValueTask()
    {
        var ch = Channel.CreateBounded<int>(new BoundedChannelOptions(64) { SingleReader = true, SingleWriter = true, AllowSynchronousContinuations = true });
        var sw = Stopwatch.StartNew();
        var p = new Thread(() =>
        {
            for (int i = 0; i < N; i++)
                while (!ch.Writer.TryWrite(i))
                    if (!ch.Writer.WaitToWriteAsync().AsTask().GetAwaiter().GetResult()) return;
            ch.Writer.Complete();
        });
        long sum = 0;
        var c = new Thread(() =>
        {
            for (int i = 0; i < N; i++)
            {
                int v;
                while (!ch.Reader.TryRead(out v))
                    if (!ch.Reader.WaitToReadAsync().AsTask().GetAwaiter().GetResult()) return;
                sum += v;
            }
        });
        p.Start(); c.Start(); p.Join(); c.Join(); sw.Stop();
        Report("bcl-blocking", sw, N);
    }

    static async Task ThroughputAsync()
    {
        var ch = Channel.CreateBounded<int>(new BoundedChannelOptions(64) { SingleReader = true, SingleWriter = true, AllowSynchronousContinuations = true });
        var sw = Stopwatch.StartNew();
        var p = Task.Run(async () => { for (int i = 0; i < N; i++) await ch.Writer.WriteAsync(i); ch.Writer.Complete(); });
        var c = Task.Run(async () => { long s = 0; while (await ch.Reader.WaitToReadAsync()) while (ch.Reader.TryRead(out var v)) s += v; return s; });
        await Task.WhenAll(p, c); sw.Stop();
        Report("bcl-async", sw, N);
    }

    static async Task ThroughputHchan()
    {
        var ch = new Hchan<int>(64);
        var sw = Stopwatch.StartNew();
        var p = Task.Run(async () => { for (int i = 0; i < N; i++) await ch.SendAsync(i); ch.Close(); });
        var c = Task.Run(async () =>
        {
            long s = 0;
            for (int i = 0; i < N; i++)
            {
                var vt = ch.ReceiveAsync(out var v);
                if (!vt.IsCompleted) { if (!await vt) break; }
                else if (!vt.Result) break;
                s += v;
            }
            return s;
        });
        await Task.WhenAll(p, c); sw.Stop();
        Report("gs-hchan", sw, N);
    }

    // Batched drain: one lock acquisition amortized over many items. Go has no
    // channel operation with this shape.
    static async Task ThroughputBatched()
    {
        var ch = Channel.CreateBounded<int>(new BoundedChannelOptions(8192) { SingleReader = true, SingleWriter = true, AllowSynchronousContinuations = true });
        var sw = Stopwatch.StartNew();
        var p = Task.Run(async () =>
        {
            for (int i = 0; i < N; i++)
                while (!ch.Writer.TryWrite(i))
                    if (!await ch.Writer.WaitToWriteAsync()) return;
            ch.Writer.Complete();
        });
        var c = Task.Run(async () => { long s = 0; while (await ch.Reader.WaitToReadAsync()) while (ch.Reader.TryRead(out var v)) s += v; return s; });
        await Task.WhenAll(p, c); sw.Stop();
        Report("bcl-batch8k", sw, N);
    }

    // Chunked transport: one channel op per 64 items.
    static async Task ThroughputChunked()
    {
        const int C = 64;
        var ch = Channel.CreateBounded<int[]>(new BoundedChannelOptions(64) { SingleReader = true, SingleWriter = true, AllowSynchronousContinuations = true });
        var sw = Stopwatch.StartNew();
        var p = Task.Run(async () =>
        {
            var chunk = new int[C]; int k = 0;
            for (int i = 0; i < N; i++)
            {
                chunk[k++] = i;
                if (k == C) { await ch.Writer.WriteAsync(chunk); chunk = new int[C]; k = 0; }
            }
            ch.Writer.Complete();
        });
        var c = Task.Run(async () => { long s = 0; while (await ch.Reader.WaitToReadAsync()) while (ch.Reader.TryRead(out var a)) for (int j = 0; j < a.Length; j++) s += a[j]; return s; });
        await Task.WhenAll(p, c); sw.Stop();
        Report("gs-chunk64", sw, N);
    }

    // Thread-pool starvation: blocked "goroutines" hold OS threads, so work
    // queued behind them cannot run. Go has no equivalent failure mode.
    static void Starvation()
    {
        const int Blockers = 400;
        var ch = Channel.CreateUnbounded<int>();
        for (int i = 0; i < Blockers; i++)
            Task.Run(() => ch.Reader.ReadAsync().AsTask().GetAwaiter().GetResult());
        Thread.Sleep(500);
        var ran = new ManualResetEventSlim();
        var sw = Stopwatch.StartNew();
        Task.Run(() => ran.Set());                    // the producer goroutine, queued last
        bool ok = ran.Wait(TimeSpan.FromSeconds(60));
        sw.Stop();
        Console.WriteLine($"[starvation  ] {Blockers} blocked receivers -> a newly spawned goroutine took {sw.Elapsed.TotalMilliseconds:F0} ms to get a thread (ran={ok}), OS threads={Process.GetCurrentProcess().Threads.Count}");
        for (int i = 0; i < Blockers; i++) ch.Writer.TryWrite(i);
    }

    // Chunked transport + SIMD stage: the shape a CLR data-processing pipeline
    // can express and Go (no portable SIMD) cannot.
    static async Task ThroughputChunkedSimd()
    {
        const int C = 1024;
        var ch = Channel.CreateBounded<int[]>(new BoundedChannelOptions(16) { SingleReader = true, SingleWriter = true, AllowSynchronousContinuations = true });
        var pool = new System.Collections.Concurrent.ConcurrentQueue<int[]>();
        var sw = Stopwatch.StartNew();
        var p = Task.Run(async () =>
        {
            for (int b = 0; b < N / C; b++)
            {
                if (!pool.TryDequeue(out var chunk)) chunk = new int[C];
                for (int k = 0; k < C; k++) chunk[k] = b * C + k;
                await ch.Writer.WriteAsync(chunk);
            }
            ch.Writer.Complete();
        });
        var c = Task.Run(async () =>
        {
            long s = 0;
            while (await ch.Reader.WaitToReadAsync())
                while (ch.Reader.TryRead(out var a))
                {
                    var acc = System.Numerics.Vector<int>.Zero;
                    int w = System.Numerics.Vector<int>.Count, j = 0;
                    for (; j <= a.Length - w; j += w) acc += new System.Numerics.Vector<int>(a, j);
                    for (int q = 0; q < w; q++) s += acc[q];
                    for (; j < a.Length; j++) s += a[j];
                    pool.Enqueue(a);
                }
            return s;
        });
        await Task.WhenAll(p, c); sw.Stop();
        Report("gs-simd1k", sw, N);
    }

    // Compute-bound stage over a batch: 4 FMA-ish ops/element.
    static async Task ComputeStage()
    {
        const int C = 1024;
        var ch = Channel.CreateBounded<float[]>(new BoundedChannelOptions(16) { SingleReader = true, SingleWriter = true, AllowSynchronousContinuations = true });
        var pool = new System.Collections.Concurrent.ConcurrentQueue<float[]>();
        var sw = Stopwatch.StartNew();
        var p = Task.Run(async () =>
        {
            for (int b = 0; b < N / C; b++)
            {
                if (!pool.TryDequeue(out var chunk)) chunk = new float[C];
                for (int k = 0; k < C; k++) chunk[k] = k;
                await ch.Writer.WriteAsync(chunk);
            }
            ch.Writer.Complete();
        });
        var c = Task.Run(async () =>
        {
            double s = 0;
            var va = new System.Numerics.Vector<float>(3.1f);
            var vb = new System.Numerics.Vector<float>(1.7f);
            var vc = new System.Numerics.Vector<float>(0.5f);
            while (await ch.Reader.WaitToReadAsync())
                while (ch.Reader.TryRead(out var a))
                {
                    var acc = System.Numerics.Vector<float>.Zero;
                    int w = System.Numerics.Vector<float>.Count, j = 0;
                    for (; j <= a.Length - w; j += w)
                    {
                        var x = new System.Numerics.Vector<float>(a, j);
                        acc += (va * x * x) + (vb * x) + vc;
                    }
                    for (int q = 0; q < w; q++) s += acc[q];
                    pool.Enqueue(a);
                }
            return s;
        });
        await Task.WhenAll(p, c); sw.Stop();
        Report("gs-compute", sw, N);
    }

    static void PingPongBounded1()
    {
        const int R = 200_000;
        var a = Channel.CreateBounded<int>(new BoundedChannelOptions(1) { AllowSynchronousContinuations = true });
        var b = Channel.CreateBounded<int>(new BoundedChannelOptions(1) { AllowSynchronousContinuations = true });
        static void Put(Channel<int> c, int v) { while (!c.Writer.TryWrite(v)) c.Writer.WaitToWriteAsync().AsTask().GetAwaiter().GetResult(); }
        static int Get(Channel<int> c) { int v; while (!c.Reader.TryRead(out v)) c.Reader.WaitToReadAsync().AsTask().GetAwaiter().GetResult(); return v; }
        var sw = Stopwatch.StartNew();
        var t = new Thread(() => { for (int i = 0; i < R; i++) Put(b, Get(a)); });
        t.Start();
        for (int i = 0; i < R; i++) { Put(a, i); Get(b); }
        t.Join(); sw.Stop();
        Report("gs-pingpong", sw, R);
    }

    // ADR-0174 Phase 1: the TRUE rendezvous baseline the ADR's D11 table was
    // missing. Two goroutine-shaped tasks alternating over two capacity-0
    // Chan<T>s — a send completes only when the receiver takes the value.
    // This is what the Phase 3 lowering emits (await SendAsync/ReceiveAsync),
    // so it is the honest G# number rather than a capacity-1 stand-in.
    static async Task PingPongRendezvous()
    {
        const int R = 200_000;
        var a = new Chan<int>();
        var b = new Chan<int>();
        var sw = Stopwatch.StartNew();
        var echo = Task.Run(async () =>
        {
            for (int i = 0; i < R; i++)
            {
                var v = await a.ReceiveAsync();
                await b.SendAsync(v.Value);
            }
        });
        for (int i = 0; i < R; i++) { await a.SendAsync(i); await b.ReceiveAsync(); }
        await echo; sw.Stop();
        Report("gs-rendezvous", sw, R);
    }

    static void ClosedReceiveCost()
    {
        const int R = 20_000;
        var ch = Channel.CreateUnbounded<int>(); ch.Writer.Complete();
        var sw = Stopwatch.StartNew();
        for (int i = 0; i < R; i++) { try { ch.Reader.ReadAsync().AsTask().GetAwaiter().GetResult(); } catch (ChannelClosedException) { } }
        sw.Stop(); Report("closed-exc", sw, R);

        var sw2 = Stopwatch.StartNew();
        for (int i = 0; i < R; i++) { if (!ch.Reader.TryRead(out _)) { } }
        sw2.Stop(); Report("closed-flag", sw2, R);

        // ADR-0174 Phase 1: the real runtime's closed receive — TryReceive on a
        // closed Chan<T> yields (zero, false) with no exception (D3).
        var gs = new Chan<int>(1); gs.Close();
        var sw3 = Stopwatch.StartNew();
        for (int i = 0; i < R; i++) { gs.TryReceive(out _, out var ok); if (ok) throw new InvalidOperationException(); }
        sw3.Stop(); Report("closed-chan", sw3, R);
    }

    sealed class Item : IThreadPoolWorkItem
    {
        public CountdownEvent? cd;
        public void Execute() => cd!.Signal();
    }

    static void SpawnCost()
    {
        const int R = 200_000;
        var cd = new CountdownEvent(R);
        var sw = Stopwatch.StartNew();
        for (int i = 0; i < R; i++) Task.Run(() => cd.Signal());
        cd.Wait(); sw.Stop(); Report("spawn-taskrun", sw, R);

        var cd2 = new CountdownEvent(R);
        var sw2 = Stopwatch.StartNew();
        for (int i = 0; i < R; i++) ThreadPool.UnsafeQueueUserWorkItem(new Item { cd = cd2 }, preferLocal: true);
        cd2.Wait(); sw2.Stop(); Report("spawn-unsafeq", sw2, R);
    }

    static async Task SelectCost()
    {
        const int R = 200_000;
        var a = Channel.CreateUnbounded<int>();
        var b = Channel.CreateUnbounded<int>();
        var prod = Task.Run(() => { for (int i = 0; i < R; i++) a.Writer.TryWrite(i); });
        long got = 0;
        var sw = Stopwatch.StartNew();
        while (got < R)
        {
            if (a.Reader.TryRead(out _)) { got++; continue; }
            if (b.Reader.TryRead(out _)) { got++; continue; }
            var tasks = new Task[2];                       // per-iteration allocation, as emitted today
            tasks[0] = a.Reader.WaitToReadAsync().AsTask();
            tasks[1] = b.Reader.WaitToReadAsync().AsTask();
            await Task.WhenAny(tasks);
        }
        sw.Stop(); await prod; Report("select2", sw, R);
    }

    static async Task ParkScale()
    {
        const int Blocked = 2_000;
        var ch = Channel.CreateUnbounded<int>();
        var done = new CountdownEvent(Blocked);
        var sw = Stopwatch.StartNew();
        for (int i = 0; i < Blocked; i++)
            _ = Task.Run(() => { ch.Reader.ReadAsync().AsTask().GetAwaiter().GetResult(); done.Signal(); });
        Thread.Sleep(2000);                      // let every receiver actually park on a thread
        int peak = Process.GetCurrentProcess().Threads.Count;
        for (int i = 0; i < Blocked; i++) ch.Writer.TryWrite(i);
        var finished = done.Wait(TimeSpan.FromSeconds(180));
        sw.Stop();
        Console.WriteLine($"[park-block  ] OS threads while {Blocked} receivers were blocked: {peak}");
        Console.WriteLine($"[park-block  ] {Blocked} blocking receivers (today's lowering): finished={finished} in {sw.Elapsed.TotalMilliseconds:F0} ms, OS threads={Process.GetCurrentProcess().Threads.Count}");

        const int Parked = 200_000;
        var ch2 = Channel.CreateUnbounded<int>();
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        long before = GC.GetTotalMemory(true);
        var sw2 = Stopwatch.StartNew();
        var tasks = new Task[Parked];
        for (int i = 0; i < Parked; i++) tasks[i] = Consume(ch2);
        await Task.Delay(300);
        long after = GC.GetTotalMemory(false);
        for (int i = 0; i < Parked; i++) ch2.Writer.TryWrite(i);
        await Task.WhenAll(tasks);
        sw2.Stop();
        Console.WriteLine($"[park-async  ] {Parked} suspended receivers: {sw2.Elapsed.TotalMilliseconds:F0} ms, ~{(after - before) / (double)Parked:F0} bytes/parked receiver, OS threads={Process.GetCurrentProcess().Threads.Count}");
    }

    static async Task Consume(Channel<int> ch) => await ch.Reader.ReadAsync();
}
