import { ChatHistoryItem } from "core";
import { useEffect, useState } from "react";
import { useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";

interface ThinkingIndicatorProps {
  historyItem: ChatHistoryItem;
}
/*
    Thinking animation
    Only for reasoning (long load time) models for now
*/
const ThinkingIndicator = ({ historyItem }: ThinkingIndicatorProps) => {
  // Animation for thinking ellipses
  const [animation, setAnimation] = useState(2);
  useEffect(() => {
    const interval = setInterval(() => {
      setAnimation((prevState) => (prevState === 2 ? 0 : prevState + 1));
    }, 600);
    return () => {
      clearInterval(interval);
    };
  }, []);

  const selectedModel = useAppSelector(selectSelectedChatModel);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const streamingStatus = useAppSelector(
    (state) => state.session.streamingStatus,
  );

  const hasContent = Array.isArray(historyItem.message.content)
    ? !!historyItem.message.content.length
    : !!historyItem.message.content;
  const isO1 = selectedModel?.model.startsWith("o1");
  const isThinking =
    isStreaming && !historyItem.isGatheringContext && !hasContent;
  if (!isThinking) {
    return null;
  }

  const label = streamingStatus ?? (isO1 ? "Thinking" : "Working");

  return (
    <div className="qivryn-thinking-indicator px-2 py-2" role="status">
      <span className="text-lightgray">
        {streamingStatus ? label : `${label}${".".repeat(animation + 1)}`}
      </span>
    </div>
  );
};

export default ThinkingIndicator;
