# Dockerfile for MCP Tool Server
FROM python:3.11-slim
WORKDIR /app
COPY ./app ./app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt --trusted-host pypi.org --trusted-host files.pythonhosted.org
EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]