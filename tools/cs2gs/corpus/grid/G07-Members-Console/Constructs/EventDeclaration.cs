// inventory: EventDeclaration — explicit add/remove accessors on a custom event (probe)
using System;
using System.Collections.Generic;

namespace Corpus.Grid07
{
    public delegate void MessageHandler(string message);

    public class Broadcaster
    {
        private readonly List<MessageHandler> _handlers = new List<MessageHandler>();

        public event MessageHandler Message
        {
            add { _handlers.Add(value); }
            remove { _handlers.Remove(value); }
        }

        public void Send(string text)
        {
            foreach (MessageHandler handler in _handlers)
            {
                handler(text);
            }
        }
    }

    public static class EventDeclarationFixture
    {
        public static void Run()
        {
            Broadcaster broadcaster = new Broadcaster();
            MessageHandler printer = message =>
            {
                Console.WriteLine("EventDeclaration: got=" + message);
            };
            broadcaster.Message += printer;
            broadcaster.Send("first");
            broadcaster.Message -= printer;
            broadcaster.Send("silent");
            Console.WriteLine("EventDeclaration: done");
        }
    }
}
